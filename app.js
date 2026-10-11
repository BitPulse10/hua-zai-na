'use strict';

const STORAGE_KEY = 'liuyibi-budget-v1';
const SCHEMA_VERSION = 5;
const V4_SCHEMA_VERSION = 4;
const V3_SCHEMA_VERSION = 3;
const PREVIOUS_SCHEMA_VERSION = 2;
const COLORS = ['#78966a','#cf9a58','#6d929a','#ba765d','#9179a9','#5e997e','#c4748d','#7785a2'];
const SETUP_DRAFT_KEY = 'liuyibi-setup-draft-v1';
const $ = (selector,root=document)=>root.querySelector(selector);
const $$ = (selector,root=document)=>[...root.querySelectorAll(selector)];
let selectedColor=COLORS[0], selectedReport='month', selectedCycleId='', selectedYear=new Date().getFullYear(), selectedDay='', selectedMonthIndex=0, detailFundId='', toastTimer=0, confirmAction=null, storageBlocked=false, storageWritable=true, onboardingNeeded=false, setupDraft=null, nativeBridge=null, nativeStorage=false, pendingNativeExportAt=null, persistenceFailureActive=false, lastPersistedState=null, state;

function newId(){return globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,11)}`}
function toCents(value){const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>9e12)return null;const c=Math.round(n*100);return Number.isSafeInteger(c)?c:null}
function centsInput(id){return toCents($(id).value)}
function money(cents){const n=(Number(cents)||0)/100;return `${n<0?'−':''}¥${Math.abs(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`}
function dateISO(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function timeISO(d){return `${dateISO(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function validDateString(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(`${value}T12:00:00`);return Number.isFinite(d.getTime())&&dateISO(d)===value}
function dateAtNoon(value){return new Date(`${value}T12:00:00`)}
function escapeHTML(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function validColor(value){return typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)}
function clampDay(year,month,day){return Math.min(Math.max(1,Number(day)||20),new Date(year,month+1,0).getDate())}
function payrollKeyFromStart(timestamp){const d=new Date(timestamp);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function currentPayrollKey(){return payrollKeyFromStart(openCycle()?.startAt??latestPaydayAt())}
function paydayAt(year,month,day=state?.payday??20,hour=state?.paydayHour??0){return new Date(year,month,clampDay(year,month,day),hour,0,0,0)}
function latestPaydayAt(ref=new Date(),day=state?.payday??20,hour=state?.paydayHour??0){
  let candidate=paydayAt(ref.getFullYear(),ref.getMonth(),day,hour);
  if(candidate>ref)candidate=paydayAt(ref.getFullYear(),ref.getMonth()-1,day,hour);
  return candidate.getTime();
}
function nextPaydayAfter(timestamp,day=state?.payday??20,hour=state?.paydayHour??0){
  const d=new Date(timestamp);let candidate=paydayAt(d.getFullYear(),d.getMonth(),day,hour);
  if(candidate.getTime()<=timestamp)candidate=paydayAt(d.getFullYear(),d.getMonth()+1,day,hour);
  return candidate.getTime();
}
function cycleIdAt(startAt){return `cycle-${Math.trunc(startAt)}`}
function makeCycle(startAt,origin='scheduled',scheduledKey=null){
  const allocations={};
  for(const f of state.funds)if(!f.disabledAt)allocations[f.id]={type:f.type,amountCents:f.type==='fixed'?f.allowanceCents:f.type==='increment'?f.contributionCents:0};
  const salarySnapshot={payrollKey:payrollKeyFromStart(startAt),netCents:state.salaryCents};
  return {id:cycleIdAt(startAt),startAt,endAt:null,origin,scheduledKey,salaryCents:state.salaryCents,salarySnapshot,payday:state.payday,paydayHour:state.paydayHour,allocations,overdrafts:[],surplusExcludedFundIds:[]};
}
function openCycle(){return [...state.cycles].filter(c=>c.endAt==null).sort((a,b)=>b.startAt-a.startAt)[0]||null}

function normalizeLegacy(raw){
  if(!raw||!Array.isArray(raw.funds)||!Array.isArray(raw.entries))throw new Error('旧备份缺少钱包或流水列表');
  const now=Date.now(),day=Number(raw.payday||20),salary=toCents(raw.totalBudget??raw.salary??raw.funds.reduce((a,f)=>a+Number(f.budget||0),0));
  if(!Number.isInteger(day)||day<1||day>31||salary==null||salary<0)throw new Error('旧备份里的发薪日或工资金额无效');
  const fundMap=new Map();
  const funds=raw.funds.map((f,i)=>{
    if(!f||typeof f.id!=='string'||!f.id||typeof f.name!=='string'||!f.name.trim())throw new Error(`第 ${i+1} 个钱包信息无效`);
    const allowance=toCents(f.budget??0);if(allowance==null||allowance<0)throw new Error(`${f.name} 的金额无效`);
    const item={id:f.id,name:f.name.trim(),type:'fixed',allowanceCents:allowance,contributionCents:0,openingCents:0,createdAt:now,color:validColor(f.color)?f.color:COLORS[i%COLORS.length],disabledAt:null};fundMap.set(item.id,item);return item;
  });
  const entries=raw.entries.map((e,i)=>{
    if(!e||typeof e.fundId!=='string'||!validDateString(e.date)||typeof e.note!=='string')throw new Error(`第 ${i+1} 笔流水的日期、用途或备注无效`);
    const amount=toCents(e.amount);if(amount==null||amount<=0)throw new Error(`第 ${i+1} 笔流水金额无效`);
    const storedTime=Number(e.createdAt),midday=dateAtNoon(e.date).getTime();
    const credible=Number.isFinite(storedTime)&&storedTime>946684800000&&Math.abs(storedTime-midday)<36*60*60*1000;
    const timestamp=credible?storedTime:midday;const fund=fundMap.get(e.fundId);
    return {id:typeof e.id==='string'&&e.id?e.id:`legacy-${i}-${newId()}`,fundId:e.fundId,fundName:fund?.name||String(e.fundName||'已删除钱包'),kind:'expense',date:e.date,timestamp,amountCents:amount,note:e.note.slice(0,200),paymentId:null,subscriptionName:null};
  });
  let startAt=latestPaydayAt(new Date(now),day,0);
  if(raw.cycleMode==='manual'&&validDateString(raw.manualCycleStart)){
    const legacyTime=Number(raw.manualCycleStartedAt);startAt=Number.isFinite(legacyTime)&&legacyTime>946684800000?legacyTime:dateAtNoon(raw.manualCycleStart).getTime();
  }
  const scheduleAt=latestPaydayAt(new Date(now),day,0);
  const migrated={schemaVersion:SCHEMA_VERSION,payday:day,paydayHour:0,scheduleChangedAt:scheduleAt,lastScheduledAt:scheduleAt,salaryCents:salary,funds,entries,cycles:[],accounts:[],accountEntries:[],accountProcessedKeys:[],rules:[],occurrences:[],legacySubscriptions:[],legacyDues:[],subscriptions:[],payments:[],savingsEntries:[],lastExportAt:null};
  const allocations={};for(const fund of funds)allocations[fund.id]={type:fund.type,amountCents:fund.allowanceCents};
  const key=payrollKeyFromStart(startAt),salarySnapshot={payrollKey:key,netCents:salary};
  const cycle={id:cycleIdAt(startAt),startAt,endAt:null,origin:raw.cycleMode==='manual'?'legacy-manual':'migration',scheduledKey:null,salaryCents:salary,salarySnapshot,payday:day,paydayHour:0,allocations,overdrafts:[],surplusExcludedFundIds:[]};migrated.cycles.push(cycle);
  for(const fund of funds)entries.push({id:newId(),fundId:fund.id,fundName:fund.name,kind:'fixed-base',date:dateISO(new Date(startAt)),timestamp:startAt,amountCents:fund.allowanceCents,note:'迁移时的本期额度',cycleId:cycle.id,paymentId:null,subscriptionName:null});
  return migrated;
}

function validateV2(raw){
  if(!raw||raw.schemaVersion!==PREVIOUS_SCHEMA_VERSION||!Array.isArray(raw.funds)||!Array.isArray(raw.entries)||!Array.isArray(raw.cycles)||!Array.isArray(raw.subscriptions)||!Array.isArray(raw.payments))throw new Error('备份格式或版本不支持');
  const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
  if(!Number.isInteger(raw.payday)||raw.payday<1||raw.payday>31||!Number.isInteger(raw.paydayHour)||raw.paydayHour<0||raw.paydayHour>23||!integer(raw.salaryCents))throw new Error('备份中的工资或发薪时间无效');
  const ids=new Set();
  for(const f of raw.funds){if(!f||typeof f.id!=='string'||!f.id||ids.has(f.id)||typeof f.name!=='string'||!f.name.trim()||!['fixed','increment','stored'].includes(f.type)||!validColor(f.color)||!integer(f.allowanceCents)||!integer(f.contributionCents)||!integer(f.openingCents)||!Number.isFinite(f.createdAt))throw new Error('备份中存在无效的钱包分类');ids.add(f.id)}
  const eventKinds=new Set(['expense','topup','fixed-base','reset','adjust','increment','opening']);
  const entryIds=new Set();
  for(const e of raw.entries){if(!e||typeof e.id!=='string'||!e.id||entryIds.has(e.id)||typeof e.fundId!=='string'||typeof e.fundName!=='string'||!eventKinds.has(e.kind)||!validDateString(e.date)||!Number.isFinite(e.timestamp)||!Number.isSafeInteger(e.amountCents)||((e.kind==='expense'||e.kind==='topup'||e.kind==='increment'||e.kind==='opening'||e.kind==='fixed-base'||e.kind==='reset')&&e.amountCents<0)||typeof e.note!=='string')throw new Error('备份中存在无效的账目或金额');entryIds.add(e.id)}
  const cycleIds=new Set();for(const c of raw.cycles){if(!c||typeof c.id!=='string'||cycleIds.has(c.id)||!Number.isFinite(c.startAt)||(c.endAt!==null&&(!Number.isFinite(c.endAt)||c.endAt<=c.startAt))||!c.allocations||typeof c.allocations!=='object'||!integer(c.salaryCents))throw new Error('备份中存在无效的周期记录');cycleIds.add(c.id);for(const a of Object.values(c.allocations))if(!a||!['fixed','increment','stored'].includes(a.type)||!integer(a.amountCents))throw new Error('备份中的钱包周期额度无效')}
  for(const s of raw.subscriptions){if(!s||typeof s.id!=='string'||typeof s.name!=='string'||!['month','year'].includes(s.frequency)||!integer(s.amountCents,1)||!validDateString(s.nextDue)||typeof s.active!=='boolean'||!Number.isInteger(s.dueDay)||s.dueDay<1||s.dueDay>31||!Number.isInteger(s.dueMonth)||s.dueMonth<0||s.dueMonth>11)throw new Error('备份中存在无效的定期付费项目')}
  for(const p of raw.payments){if(!p||typeof p.id!=='string'||typeof p.subscriptionId!=='string'||typeof p.subscriptionName!=='string'||!validDateString(p.dueDate)||!integer(p.amountCents,1)||!['pending','paid','cancelled'].includes(p.status)||(p.status==='paid'&&(!Number.isFinite(p.paidAt)||!Number.isSafeInteger(p.actualAmountCents)||!validDateString(p.actualDate)||typeof p.fundId!=='string')))throw new Error('备份中存在无效的定期付费账单')}
  return structuredClone(raw);
}

function migrateV2ToV3(raw){
  const old=validateV2(raw),current=latestPaydayAt(new Date(),old.payday,old.paydayHour),migrated={...old,schemaVersion:V3_SCHEMA_VERSION,lastScheduledAt:Number.isFinite(old.lastScheduledAt)?old.lastScheduledAt:current,scheduleChangedAt:Number.isFinite(old.scheduleChangedAt)?old.scheduleChangedAt:current,salaryConfig:{adjustments:{},personalSocialCents:0,personalProvidentCents:0,incomeTaxCents:0,otherDeductionCents:0},accounts:[],accountEntries:[],rules:[],occurrences:[],legacySubscriptions:old.subscriptions.map(s=>({...s,fundId:null,boundAt:null})),legacyDues:old.payments.filter(p=>p.status==='pending').map(p=>({...p,fundId:null,legacyStatus:'unbound'}))};
  migrated.cycles=migrated.cycles.map(c=>({...c,salarySnapshot:c.salarySnapshot||{payrollKey:payrollKeyFromStart(c.startAt),contractCents:c.salaryCents,adjustmentCents:0,grossPayCents:c.salaryCents,personalSocialCents:0,personalProvidentCents:0,incomeTaxCents:0,otherDeductionCents:0,deductionCents:0,takeHomeCents:c.salaryCents}}));
  return validateV3(migrated);
}

function validateV3(raw){
  if(!raw||raw.schemaVersion!==V3_SCHEMA_VERSION||!Array.isArray(raw.funds)||!Array.isArray(raw.entries)||!Array.isArray(raw.cycles)||!Array.isArray(raw.accounts)||!Array.isArray(raw.accountEntries)||!Array.isArray(raw.rules)||!Array.isArray(raw.occurrences)||!Array.isArray(raw.legacySubscriptions)||!Array.isArray(raw.legacyDues)||!Array.isArray(raw.subscriptions)||!Array.isArray(raw.payments))throw new Error('备份格式或版本不支持');
  const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
  const copy=structuredClone(raw);
  if(!Number.isInteger(copy.payday)||copy.payday<1||copy.payday>31||!Number.isInteger(copy.paydayHour)||copy.paydayHour<0||copy.paydayHour>23||!integer(copy.salaryCents)||!Number.isFinite(copy.lastScheduledAt)||!Number.isFinite(copy.scheduleChangedAt))throw new Error('备份中的工资或发薪时间无效');
  const config=copy.salaryConfig;if(!config||!config.adjustments||typeof config.adjustments!=='object')throw new Error('备份中的工资设置无效');
  for(const key of ['personalSocialCents','personalProvidentCents','incomeTaxCents','otherDeductionCents'])if(!integer(config[key]))throw new Error('备份中的工资扣款金额无效');
  for(const [key,value] of Object.entries(config.adjustments))if(!/^\d{4}-\d{2}$/.test(key)||!Number.isSafeInteger(value))throw new Error('备份中的工资调整金额无效');
  const standardDeduction=config.personalSocialCents+config.personalProvidentCents+config.incomeTaxCents+config.otherDeductionCents,currentKey=payrollKeyFromStart(latestPaydayAt(new Date(),copy.payday,copy.paydayHour));if(copy.salaryCents-standardDeduction<0||Object.entries(config.adjustments).some(([key,value])=>key>=currentKey&&copy.salaryCents+value-standardDeduction<0))throw new Error('备份中的工资扣款超过应发工资');
  const fundIds=new Set();for(const f of copy.funds){if(!f||typeof f.id!=='string'||!f.id||fundIds.has(f.id)||typeof f.name!=='string'||!f.name.trim()||!['fixed','increment','stored'].includes(f.type)||!validColor(f.color)||!integer(f.allowanceCents)||!integer(f.contributionCents)||!integer(f.openingCents)||!Number.isFinite(f.createdAt))throw new Error('备份中存在无效的钱包分类');fundIds.add(f.id)}
  const eventKinds=new Set(['expense','topup','fixed-base','reset','adjust','increment','opening','transfer-in']);const entryIds=new Set();for(const e of copy.entries){if(!e||typeof e.id!=='string'||!e.id||entryIds.has(e.id)||typeof e.fundId!=='string'||typeof e.fundName!=='string'||!eventKinds.has(e.kind)||!validDateString(e.date)||!Number.isFinite(e.timestamp)||!Number.isSafeInteger(e.amountCents)||(e.kind!=='adjust'&&e.amountCents<0)||typeof e.note!=='string')throw new Error('备份中存在无效的钱包账目');entryIds.add(e.id)}
  const cycleIds=new Set();for(const c of copy.cycles){if(!c||typeof c.id!=='string'||cycleIds.has(c.id)||!Number.isFinite(c.startAt)||(c.endAt!==null&&(!Number.isFinite(c.endAt)||c.endAt<=c.startAt))||!c.allocations||typeof c.allocations!=='object'||!integer(c.salaryCents))throw new Error('备份中存在无效的周期记录');cycleIds.add(c.id);for(const a of Object.values(c.allocations))if(!a||!['fixed','increment','stored','savings'].includes(a.type)||!integer(a.amountCents))throw new Error('备份中的钱包周期额度无效');if(c.salarySnapshot){const s=c.salarySnapshot,total=(s.personalSocialCents||0)+(s.personalProvidentCents||0)+(s.incomeTaxCents||0)+(s.otherDeductionCents||0);if(!integer(s.contractCents)||!Number.isSafeInteger(s.adjustmentCents)||!integer(s.grossPayCents)||!integer(s.takeHomeCents)||!integer(s.personalSocialCents)||!integer(s.personalProvidentCents)||!integer(s.incomeTaxCents)||!integer(s.otherDeductionCents)||s.grossPayCents!==s.contractCents+s.adjustmentCents||s.grossPayCents<total||s.takeHomeCents!==s.grossPayCents-total)throw new Error('备份中的周期工资快照无效')}}
  const accountIds=new Set();for(const a of copy.accounts){if(!a||typeof a.id!=='string'||!a.id||accountIds.has(a.id)||!['provident','medical'].includes(a.type)||typeof a.name!=='string'||!a.name.trim()||!integer(a.openingCents)||!integer(a.defaultPersonalCents)||!integer(a.defaultCompanyCents)||!Number.isFinite(a.createdAt))throw new Error('备份中存在无效的公积金或医保账户');accountIds.add(a.id)}
  const accountKinds=new Set(['opening','provident-credit','medical-credit','expense','transfer-out']),accountEntryIds=new Set();for(const e of copy.accountEntries)if(!e||typeof e.id!=='string'||!e.id||accountEntryIds.has(e.id)||typeof e.accountId!=='string'||!accountKinds.has(e.kind)||!validDateString(e.date)||!Number.isFinite(e.timestamp)||!integer(e.amountCents)||typeof e.note!=='string'||(e.kind==='provident-credit'&&(!integer(e.personalCents)||!integer(e.companyCents)||e.personalCents+e.companyCents!==e.amountCents)))throw new Error('备份中存在无效的账户流水');else accountEntryIds.add(e.id);
  const ruleIds=new Set();for(const r of copy.rules)if(!r||typeof r.id!=='string'||!r.id||ruleIds.has(r.id)||typeof r.fundId!=='string'||typeof r.fundName!=='string'||!r.fundName||typeof r.name!=='string'||!r.name.trim()||!integer(r.amountCents,1)||!['month','quarter','year'].includes(r.frequency)||!Number.isFinite(r.firstDueAt)||!Number.isFinite(r.nextDueAt)||!Number.isInteger(r.anchorDay)||r.anchorDay<1||r.anchorDay>31||!Number.isInteger(r.anchorMonth)||r.anchorMonth<0||r.anchorMonth>11||!Number.isInteger(r.anchorHour)||r.anchorHour<0||r.anchorHour>23||typeof r.active!=='boolean')throw new Error('备份中存在无效的消费计划');else ruleIds.add(r.id);
  const occurrenceIds=new Set();for(const o of copy.occurrences)if(!o||typeof o.id!=='string'||occurrenceIds.has(o.id)||typeof o.ruleId!=='string'||!Number.isFinite(o.dueAt)||!['posted','exception','resolved','cancelled'].includes(o.status)||!Number.isSafeInteger(o.amountCents)||o.amountCents<0)throw new Error('备份中存在无效的计划消费到期记录');else occurrenceIds.add(o.id);
  const legacySubscriptionIds=new Set();for(const s of copy.legacySubscriptions)if(!s||typeof s.id!=='string'||!s.id||legacySubscriptionIds.has(s.id)||typeof s.name!=='string'||!s.name.trim()||!validDateString(s.nextDue)||!['month','year'].includes(s.frequency)||!integer(s.amountCents,1)||typeof s.active!=='boolean')throw new Error('备份中的旧计划资料无效');else legacySubscriptionIds.add(s.id);
  const legacyDueIds=new Set();for(const d of copy.legacyDues)if(!d||typeof d.id!=='string'||!d.id||legacyDueIds.has(d.id)||typeof d.subscriptionName!=='string'||!validDateString(d.dueDate)||!integer(d.amountCents,1)||!['unbound','pending','posted','cancelled'].includes(d.legacyStatus)||(d.fundId!=null&&typeof d.fundId!=='string'))throw new Error('备份中的旧待处理消费无效');else legacyDueIds.add(d.id);
  const paymentIds=new Set();for(const p of copy.payments)if(!p||typeof p.id!=='string'||!p.id||paymentIds.has(p.id)||typeof p.subscriptionId!=='string'||typeof p.subscriptionName!=='string'||!validDateString(p.dueDate)||!integer(p.amountCents,1)||!['pending','paid','cancelled'].includes(p.status)||(p.status==='paid'&&(!Number.isFinite(p.paidAt)||!integer(p.actualAmountCents)||!validDateString(p.actualDate)||typeof p.fundId!=='string')))throw new Error('备份中存在无效的旧定期消费账单');else paymentIds.add(p.id);
  return copy;
}

function migrateV3ToV4(raw){
  const copy=validateV3(raw),current=copy.cycles.filter(c=>c.endAt==null).sort((a,b)=>b.startAt-a.startAt)[0],key=payrollKeyFromStart(current?.startAt??latestPaydayAt(new Date(),copy.payday,copy.paydayHour)),config=copy.salaryConfig||{},deductions=(config.personalSocialCents||0)+(config.personalProvidentCents||0)+(config.incomeTaxCents||0)+(config.otherDeductionCents||0),net=copy.salaryCents+(config.adjustments?.[key]||0)-deductions;
  if(!Number.isSafeInteger(net)||net<0)throw new Error('旧版当前到手工资无效，不能迁移');
  const anchor=Math.max(Date.now(),copy.lastScheduledAt||latestPaydayAt(new Date(),copy.payday,copy.paydayHour),copy.scheduleChangedAt||0),effectiveFromAt=nextPaydayAfter(anchor,copy.payday,copy.paydayHour);
  const migrated={...copy,schemaVersion:V4_SCHEMA_VERSION,salaryCents:net,accountProcessedKeys:[],savingsEntries:[]};delete migrated.salaryConfig;
  migrated.accounts=migrated.accounts.map(a=>({...a,monthlyPersonalCents:a.type==='provident'?(a.monthlyPersonalCents??a.defaultPersonalCents??0):0,monthlyCompanyCents:a.type==='provident'?(a.monthlyCompanyCents??a.defaultCompanyCents??0):0,monthlyMedicalCents:a.type==='medical'?(a.monthlyMedicalCents??a.defaultPersonalCents??0):0,effectiveFromAt:a.effectiveFromAt??effectiveFromAt}));
  migrated.occurrences=migrated.occurrences.map(o=>({...o,status:o.status==='exception'?'pending':o.status}));
  return validateV4(migrated);
}

function validateV4(raw){
  if(!raw||raw.schemaVersion!==V4_SCHEMA_VERSION||!Array.isArray(raw.funds)||!Array.isArray(raw.entries)||!Array.isArray(raw.cycles)||!Array.isArray(raw.accounts)||!Array.isArray(raw.accountEntries)||!Array.isArray(raw.rules)||!Array.isArray(raw.occurrences)||!Array.isArray(raw.legacySubscriptions)||!Array.isArray(raw.legacyDues)||!Array.isArray(raw.subscriptions)||!Array.isArray(raw.payments)||!Array.isArray(raw.accountProcessedKeys)||!Array.isArray(raw.savingsEntries))throw new Error('备份格式或版本不支持');
  const copy=structuredClone(raw),integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
  if(!integer(copy.salaryCents))throw new Error('备份中的月到手工资无效');
  const accountKeys=new Set();for(const key of copy.accountProcessedKeys)if(typeof key!=='string'||!key||accountKeys.has(key))throw new Error('备份中的账户入账标记无效');else accountKeys.add(key);
  const cyclesById=new Map(copy.cycles.map(c=>[c?.id,c]));for(const c of copy.cycles){const hasSettledAt=Object.hasOwn(c||{},'surplusSettledAt'),hasSettlementCycle=Object.hasOwn(c||{},'surplusSettlementCycleId');if(hasSettledAt!==hasSettlementCycle)throw new Error('备份中的周期历月结余标记不完整');if(hasSettledAt){const next=cyclesById.get(c.surplusSettlementCycleId);if(!Number.isFinite(c.surplusSettledAt)||c.endAt==null||c.surplusSettledAt!==c.endAt||typeof c.surplusSettlementCycleId!=='string'||!c.surplusSettlementCycleId||!next||next.startAt!==c.endAt)throw new Error('备份中的周期历月结余标记无效')}}
  const fundKinds=new Set(['fixed','increment','stored','savings']);for(const f of copy.funds)if(!fundKinds.has(f.type))throw new Error('备份中存在无效的钱包类型');
  const newEntryKinds=new Set(['expense','topup','fixed-base','reset','adjust','increment','opening','transfer-in','surplus-out','transfer-out','extra-income','extra-savings','savings-in']);for(const e of copy.entries)if(!newEntryKinds.has(e.kind)||!Number.isSafeInteger(e.amountCents)||(e.kind!=='adjust'&&e.amountCents<0))throw new Error('备份中存在无效的钱包流水或金额');
  const ruleIds=new Set();for(const r of copy.rules){if(!r||ruleIds.has(r.id)||!['month','quarter','year','once'].includes(r.frequency))throw new Error('备份中存在无效的消费计划');ruleIds.add(r.id)}
  const occurrenceIds=new Set();for(const o of copy.occurrences){if(!o||occurrenceIds.has(o.id)||!['posted','pending','confirmed','exception','resolved','cancelled'].includes(o.status))throw new Error('备份中存在无效的待确认账单');occurrenceIds.add(o.id)}
  for(const a of copy.accounts){if(!integer(a.monthlyPersonalCents)||!integer(a.monthlyCompanyCents)||!integer(a.monthlyMedicalCents)||!Number.isFinite(a.effectiveFromAt))throw new Error('备份中的账户每月入账设置无效');if(a.type==='medical'&&(a.monthlyPersonalCents||a.monthlyCompanyCents))throw new Error('医保账户只能配置实际划入金额')}
  const savingsIds=new Set(),savingsKinds=new Set(['surplus-in','transfer-out','expense']);for(const e of copy.savingsEntries)if(!e||typeof e.id!=='string'||!e.id||savingsIds.has(e.id)||!savingsKinds.has(e.kind)||!integer(e.amountCents,1)||!validDateString(e.date)||!Number.isFinite(e.timestamp)||typeof e.note!=='string'||(e.kind==='surplus-in'&&typeof e.sourceFundId!=='string')||(e.kind==='transfer-out'&&typeof e.targetFundId!=='string'))throw new Error('备份中的长期储蓄流水无效');else savingsIds.add(e.id);
  const projected=structuredClone(copy);projected.schemaVersion=V3_SCHEMA_VERSION;projected.salaryConfig={adjustments:{},personalSocialCents:0,personalProvidentCents:0,incomeTaxCents:0,otherDeductionCents:0};
  projected.funds=projected.funds.map(f=>f.type==='savings'?{...f,type:'stored'}:f);
  projected.cycles=projected.cycles.map(c=>({...c,allocations:Object.fromEntries(Object.entries(c.allocations).map(([id,a])=>[id,a.type==='savings'?{...a,type:'stored'}:a]))}));
  projected.entries=projected.entries.map(e=>['surplus-out','transfer-out','extra-income','extra-savings','savings-in'].includes(e.kind)?{...e,kind:'opening'}:e);
  projected.rules=projected.rules.map(r=>r.frequency==='once'?{...r,frequency:'month'}:r);
  projected.occurrences=projected.occurrences.map(o=>({...o,status:o.status==='pending'?'exception':o.status==='confirmed'?'resolved':o.status}));
  projected.cycles=projected.cycles.map(c=>c.salarySnapshot?.netCents!=null?{...c,salarySnapshot:{payrollKey:c.salarySnapshot.payrollKey||payrollKeyFromStart(c.startAt),contractCents:c.salaryCents,adjustmentCents:0,grossPayCents:c.salaryCents,personalSocialCents:0,personalProvidentCents:0,incomeTaxCents:0,otherDeductionCents:0,deductionCents:0,takeHomeCents:c.salaryCents}}:c);
  validateV3(projected);return copy;
}

function validateV5(raw){
  if(!raw||raw.schemaVersion!==SCHEMA_VERSION||!Array.isArray(raw.funds)||!Array.isArray(raw.cycles)||!Array.isArray(raw.entries)||!Array.isArray(raw.savingsEntries))throw new Error('备份格式或版本不支持');
  const copy=structuredClone(raw),downgradeKind=kind=>['overdraft-settlement','overdraft-adjust','overdraft-transfer'].includes(kind)?'adjust':kind;
  const projected={...copy,schemaVersion:V4_SCHEMA_VERSION,funds:copy.funds.map(({disabledAt,...fund})=>fund),cycles:copy.cycles.map(({overdrafts,surplusExcludedFundIds,...cycle})=>cycle),entries:copy.entries.map(e=>({...e,kind:downgradeKind(e.kind)})),savingsEntries:copy.savingsEntries.map(e=>['overdraft-settlement','overdraft-adjust'].includes(e.kind)?{...e,kind:e.kind==='overdraft-settlement'?'transfer-out':'expense',amountCents:Math.max(1,e.amountCents),targetFundId:e.kind==='overdraft-settlement'?(e.targetFundId||'validation-only'):e.targetFundId}:e)};
  validateV4(projected);
  const integer=Number.isSafeInteger;
  for(const fund of copy.funds)if(fund.disabledAt!==null&&fund.disabledAt!==undefined&&!Number.isFinite(fund.disabledAt))throw new Error('备份中的钱包停用时间无效');
  for(const cycle of copy.cycles){
    if(cycle.surplusExcludedFundIds!==undefined&&(!Array.isArray(cycle.surplusExcludedFundIds)||cycle.surplusExcludedFundIds.some(id=>typeof id!=='string')))throw new Error('备份中的周期盈余排除标记无效');
    if(cycle.overdrafts!==undefined){if(!Array.isArray(cycle.overdrafts))throw new Error('备份中的待处理超支记录无效');const ids=new Set();for(const item of cycle.overdrafts)if(!item||typeof item.sourceFundId!=='string'||!item.sourceFundId||typeof item.sourceFundName!=='string'||!item.sourceFundName||!integer(item.amountCents)||item.amountCents<=0||ids.has(item.sourceFundId))throw new Error('备份中的待处理超支记录无效');else ids.add(item.sourceFundId)}
  }
  const adjustmentKinds=new Set(['overdraft-settlement','overdraft-adjust','overdraft-transfer']);
  for(const entry of copy.entries)if(adjustmentKinds.has(entry.kind)&&(!entry||typeof entry.sourceCycleId!=='string'||!entry.sourceCycleId||typeof entry.sourceFundId!=='string'||!entry.sourceFundId||!Number.isSafeInteger(entry.amountCents)||entry.amountCents<=0))throw new Error('备份中的超支处理流水无效');
  for(const entry of copy.savingsEntries)if(['overdraft-settlement','overdraft-adjust'].includes(entry.kind)&&(!entry||typeof entry.sourceCycleId!=='string'||!entry.sourceCycleId||typeof entry.sourceFundId!=='string'||!entry.sourceFundId||!Number.isSafeInteger(entry.amountCents)||entry.amountCents<=0))throw new Error('备份中的结余超支处理流水无效');
  if(copy.lastExportAt!==undefined&&copy.lastExportAt!==null&&!Number.isFinite(copy.lastExportAt))throw new Error('备份中的导出时间无效');
  copy.funds=copy.funds.map(f=>({...f,disabledAt:f.disabledAt??null}));
  copy.cycles=copy.cycles.map(c=>({...c,overdrafts:c.overdrafts||[],surplusExcludedFundIds:c.surplusExcludedFundIds||[]}));
  copy.funds=copy.funds.map(f=>f.type==='savings'?{...f,type:'increment',contributionCents:0}:f);
  copy.lastExportAt=copy.lastExportAt??null;
  return copy;
}

function migrateV4ToV5(raw){
  const old=validateV4(raw),copy={...old,schemaVersion:SCHEMA_VERSION,lastExportAt:null,funds:old.funds.map(f=>({...f,disabledAt:null})),cycles:old.cycles.map(c=>({...c,overdrafts:[],surplusExcludedFundIds:[]}))};
  return validateV5(copy);
}

function emptyLedgerState(){return normalizeLegacy({payday:20,totalBudget:0,funds:[],entries:[]})}
function decodeLedger(raw){
  const parsed=typeof raw==='string'?JSON.parse(raw):raw;
  if(parsed?._nativeReadError)throw new Error(String(parsed._nativeReadError));
  if(parsed?.schemaVersion===SCHEMA_VERSION)return validateV5(parsed);
  if(parsed?.schemaVersion===V4_SCHEMA_VERSION)return migrateV4ToV5(parsed);
  if(parsed?.schemaVersion===V3_SCHEMA_VERSION)return migrateV4ToV5(migrateV3ToV4(parsed));
  if(parsed?.schemaVersion===PREVIOUS_SCHEMA_VERSION)return migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(parsed)));
  return normalizeLegacy(parsed);
}
function readSetupDraft(){
  try{
    const raw=nativeStorage&&typeof nativeBridge.readSetupDraft==='function'?nativeBridge.readSetupDraft():localStorage.getItem(SETUP_DRAFT_KEY);
    if(!raw)return null;const value=typeof raw==='string'?JSON.parse(raw):raw;return value&&value.version===1&&value.fields?value:null;
  }catch{return null}
}
function writeSetupDraft(value){
  try{
    if(nativeStorage&&typeof nativeBridge.saveSetupDraft==='function')return nativeBridge.saveSetupDraft(JSON.stringify(value))===true;
    localStorage.setItem(SETUP_DRAFT_KEY,JSON.stringify(value));return true;
  }catch{return false}
}
function clearSetupDraft(){try{if(nativeStorage&&typeof nativeBridge.clearSetupDraft==='function')nativeBridge.clearSetupDraft();else localStorage.removeItem(SETUP_DRAFT_KEY)}catch{}}
function loadState(){
  nativeBridge=window.AndroidLedger||null;
  nativeStorage=Boolean(nativeBridge&&typeof nativeBridge.readLedger==='function'&&typeof nativeBridge.saveLedger==='function');
  if(nativeStorage){
    let raw='';
    try{raw=nativeBridge.readLedger()||'';storageWritable=true}catch(error){storageWritable=false;storageBlocked=true;setStorageWarning('无法读取 Android 本地账本，已暂停写入以保护原数据。请重启应用后重试，或从设置导入有效备份。');return emptyLedgerState()}
    if(raw){try{return decodeLedger(raw)}catch(error){storageBlocked=true;setStorageWarning(`Android 本地账本读取失败，为避免覆盖原数据，已暂停写入。${error.message||'请从设置导入有效备份。'}`);return emptyLedgerState()}}
    if(typeof nativeBridge.readLegacyLedger==='function'){
      let legacy='';try{legacy=nativeBridge.readLegacyLedger()||''}catch(error){storageBlocked=true;setStorageWarning('无法读取旧版 Android 账本，已暂停写入以保护原数据。请重启应用后重试，或导入有效备份。');return emptyLedgerState()}
      if(legacy){try{const migrated=decodeLedger(legacy);if(!migrated.cycles.length&&migrated.funds.length)throw new Error('旧账本没有可用周期');return migrated}catch(error){storageBlocked=true;setStorageWarning(`旧版 Android 账本转换失败，为避免覆盖原数据，已暂停写入。${error.message||'请先导入有效备份。'}`);return emptyLedgerState()}}
    }
    onboardingNeeded=true;setupDraft=readSetupDraft();return emptyLedgerState();
  }
  let raw='';
  try{raw=localStorage.getItem(STORAGE_KEY);storageWritable=true}catch(error){storageWritable=false;storageBlocked=true;setStorageWarning('浏览器拒绝读取本地账本，已暂停写入以保护原数据。请检查浏览器存储权限，或导入有效备份。');return emptyLedgerState()}
  if(!raw){onboardingNeeded=true;setupDraft=readSetupDraft();return emptyLedgerState()}
  try{return decodeLedger(raw)}
  catch(error){storageBlocked=true;setStorageWarning(`本地数据读取失败，为避免覆盖原数据，已暂停保存。${error.message||'请先导出浏览器数据或导入有效备份。'}`);return emptyLedgerState()}
}
function setStorageWarning(message){const node=$('#storageWarning');if(node){node.textContent=message;node.hidden=false}}
function updateStorageWarning(){const node=$('#storageWarning');if(storageBlocked){node.textContent='本地数据读取失败，保存已暂停以保护原数据。请导入有效备份后再继续。';node.hidden=false}else if(!storageWritable){node.textContent=nativeStorage?'Android 本地账本保存失败；刚才的更改已撤销，请稍后重试。':'浏览器无法保存数据；刚才的更改已撤销，请启用浏览器本地存储。';node.hidden=false}else{node.hidden=true}}
state=loadState();
lastPersistedState=structuredClone(state);
if(!onboardingNeeded&&!storageBlocked)reconcileClosedCycleSurpluses();

function persist(renderAfter=true,allowRepair=false){
  if(storageBlocked&&!allowRepair){showToast('保存已暂停，先导入有效备份以保护原数据');return false}
  try{
    const serialized=JSON.stringify(state);
    if(nativeStorage){if(nativeBridge.saveLedger(serialized)!==true)throw new Error('Android 未能保存账本')}
    else localStorage.setItem(STORAGE_KEY,serialized);
    lastPersistedState=structuredClone(state);storageWritable=true;persistenceFailureActive=false;updateStorageWarning();
  }catch(error){
    if(lastPersistedState)state=structuredClone(lastPersistedState);
    if(allowRepair)storageBlocked=true;
    storageWritable=false;updateStorageWarning();if(renderAfter)render();persistenceFailureActive=true;showToast(nativeStorage?'Android 未能保存账本，变更已撤销':'浏览器没有保存成功，变更已撤销',true);setTimeout(()=>{persistenceFailureActive=false},0);return false;
  }
  if(renderAfter)render();return true;
}
function addLedger(fund,kind,amountCents,note='',timestamp=Date.now(),extra={}){
  const date=dateISO(new Date(timestamp)),cycle=cycleForTimestamp(timestamp),row={id:newId(),fundId:fund.id,fundName:fund.name,kind,date,timestamp,amountCents,note:String(note||''),cycleId:cycle?.id||null,paymentId:null,subscriptionName:null,...extra};state.entries.push(row);return row;
}
function snapshotAllocation(cycle,fund){cycle.allocations[fund.id]={type:fund.type,amountCents:fund.type==='fixed'?fund.allowanceCents:fund.type==='increment'?fund.contributionCents:0}}
function addCycleStartEvents(cycle,timestamp,initial=false){
  for(const fund of state.funds){if(fund.disabledAt)continue;snapshotAllocation(cycle,fund);if(fund.type==='fixed'){const carried=fund.restoredAt?Math.max(0,fundBalanceAt(fund,timestamp-1)):0;addLedger(fund,initial?'fixed-base':'reset',fund.allowanceCents,initial?'本期额度':'新周期恢复额度',timestamp,{cycleId:cycle.id});if(carried>0)addLedger(fund,'adjust',carried,'恢复钱包：保留停用前余额',timestamp,{cycleId:cycle.id});if(fund.restoredAt)delete fund.restoredAt}else if(fund.type==='increment'&&!initial&&fund.contributionCents>0)addLedger(fund,'increment',fund.contributionCents,'长期储蓄每月自动存入',timestamp,{cycleId:cycle.id})}
}
function sweepFixedSurplus(oldCycle,timestamp,newCycleId){
  if(!oldCycle||!Array.isArray(state.savingsEntries))return;oldCycle.endAt=timestamp;oldCycle.surplusSettledAt=timestamp;oldCycle.surplusSettlementCycleId=newCycleId;oldCycle.surplusExcludedFundIds=[...new Set([...(oldCycle.surplusExcludedFundIds||[]),...state.funds.filter(f=>f.disabledAt&&f.disabledAt<=timestamp).map(f=>f.id)])];refreshFixedSurplusSettlement(oldCycle);
}
function fixedFundBalanceBeforeSettlement(fundId,timestamp,ignoredEntryId,fallbackCents){
  const ignored=new Set(String(ignoredEntryId||'').split('|')),priority=e=>['fixed-base','reset'].includes(e.kind)?0:e.kind==='adjust'?1:e.kind==='transfer-in'?2:3,rows=state.entries.filter(e=>e.fundId===fundId&&!ignored.has(e.id)&&e.timestamp<=timestamp).sort((a,b)=>a.timestamp-b.timestamp||priority(a)-priority(b));let base=null,balance=0;
  for(const e of rows){if(e.kind==='fixed-base'||e.kind==='reset'){base=e.timestamp;balance=e.amountCents}else if(base!=null&&e.timestamp>=base){if(e.kind==='expense'||e.kind==='transfer-out'||e.kind==='surplus-out'||e.kind==='overdraft-settlement')balance-=e.amountCents;else if(e.kind==='adjust'||e.kind==='transfer-in'||e.kind==='extra-income'||e.kind==='overdraft-adjust'||e.kind==='overdraft-transfer')balance+=e.amountCents}}
  return base==null?fallbackCents:balance;
}
function refreshFixedSurplusSettlement(cycle){
  if(!cycle||cycle.endAt==null||!Number.isFinite(cycle.endAt))return;const settlementAt=Number.isFinite(cycle.surplusSettledAt)?cycle.surplusSettledAt:cycle.endAt,stamp=Math.min(cycle.endAt-1,settlementAt-1),settlementCycleId=cycle.surplusSettlementCycleId||state.cycles.filter(c=>c.startAt===cycle.endAt).sort((a,b)=>a.startAt-b.startAt)[0]?.id||null,date=dateISO(new Date(stamp)),excluded=new Set(cycle.surplusExcludedFundIds||[]),shortfalls=[];
  for(const [fundId,allocation] of Object.entries(cycle.allocations||{})){if(allocation?.type!=='fixed')continue;const outId=`surplus-out-${cycle.id}-${fundId}`,inId=`surplus-in-${cycle.id}-${fundId}`,transferId=`overdraft-transfer-${cycle.id}-${fundId}`,name=getFund(fundId)?.name||state.entries.find(e=>e.fundId===fundId)?.fundName||'已删除钱包',balance=fixedFundBalanceBeforeSettlement(fundId,stamp,`${outId}|${transferId}`,allocation.amountCents||0),deficit=Math.max(0,-balance),surplusExcluded=excluded.has(fundId);
    if(deficit>0)shortfalls.push({sourceFundId:fundId,sourceFundName:name,amountCents:deficit});
    const transfer=state.entries.find(e=>e.id===transferId);
    if(surplusExcluded&&deficit>0){const row={id:transferId,fundId,fundName:name,kind:'overdraft-transfer',date:dateISO(new Date(cycle.endAt)),timestamp:cycle.endAt,amountCents:deficit,note:'停用钱包的历史缺口转入待处理',cycleId:cycle.id,sourceCycleId:cycle.id,sourceFundId:fundId};if(transfer)Object.assign(transfer,row);else state.entries.push(row)}else state.entries=state.entries.filter(e=>e.id!==transferId);
    const amount=surplusExcluded?0:Math.max(0,balance);
    if(amount<=0){state.entries=state.entries.filter(e=>e.id!==outId);state.savingsEntries=state.savingsEntries.filter(e=>e.id!==inId);continue}
    const out={id:outId,fundId,fundName:name,kind:'surplus-out',date,timestamp:stamp,amountCents:amount,note:'周期结余转入累计结余',cycleId:cycle.id,settlementCycleId};const savings={id:inId,kind:'surplus-in',date,timestamp:stamp,amountCents:amount,note:`${name} 上期结余`,sourceFundId:fundId,sourceFundName:name,sourceCycleId:cycle.id,settlementCycleId};
    const oldOut=state.entries.find(e=>e.id===outId);if(oldOut)Object.assign(oldOut,out);else state.entries.push(out);const oldIn=state.savingsEntries.find(e=>e.id===inId);if(oldIn)Object.assign(oldIn,savings);else state.savingsEntries.push(savings);
  }
  cycle.overdrafts=shortfalls;reconcileOverdraftAdjustments(cycle);
}
function overdraftSettlementRows(cycleId,sourceFundId=null){return [...state.entries.filter(e=>e.kind==='overdraft-settlement'&&e.sourceCycleId===cycleId&&(!sourceFundId||e.sourceFundId===sourceFundId)),...state.savingsEntries.filter(e=>e.kind==='overdraft-settlement'&&e.sourceCycleId===cycleId&&(!sourceFundId||e.sourceFundId===sourceFundId))]}
function overdraftCorrectionRows(cycleId,sourceFundId){return [...state.entries.filter(e=>e.kind==='overdraft-adjust'&&e.sourceCycleId===cycleId&&e.sourceFundId===sourceFundId),...state.savingsEntries.filter(e=>e.kind==='overdraft-adjust'&&e.sourceCycleId===cycleId&&e.sourceFundId===sourceFundId)]}
function reconcileOverdraftAdjustments(cycle){
  const currentShortfall=new Map((cycle.overdrafts||[]).map(item=>[item.sourceFundId,item.amountCents])),sourceIds=new Set([...currentShortfall.keys(),...overdraftSettlementRows(cycle.id).map(e=>e.sourceFundId)]);
  for(const sourceFundId of sourceIds){const settlements=overdraftSettlementRows(cycle.id,sourceFundId).sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id)),grouped=new Map();for(const row of settlements){const payerId=row.fundId||row.settlementFundId||'savings';grouped.set(payerId,(grouped.get(payerId)||0)+row.amountCents)}
    let remaining=currentShortfall.get(sourceFundId)||0;for(const [payerId,paid] of grouped){const currentRefund=overdraftCorrectionRows(cycle.id,sourceFundId).filter(row=>(row.fundId||row.settlementFundId||'savings')===payerId).reduce((sum,row)=>sum+row.amountCents,0),netPaid=Math.max(0,paid-currentRefund),applied=Math.min(remaining,netPaid),targetRefund=Math.max(currentRefund,paid-applied);remaining-=applied;const delta=Math.max(0,targetRefund-currentRefund);if(!delta)continue;
      const timestamp=Date.now(),note=`回溯修正：已补齐超额 ${money(delta)}，退回${getFund(payerId)?'原钱包':'累计结余'}`;
      if(payerId!=='savings'&&getFund(payerId))addLedger(getFund(payerId),'overdraft-adjust',delta,note,timestamp,{sourceCycleId:cycle.id,sourceFundId,settlementFundId:payerId});
      else state.savingsEntries.push({id:newId(),kind:'overdraft-adjust',date:dateISO(new Date(timestamp)),timestamp,amountCents:delta,note,sourceCycleId:cycle.id,sourceFundId,settlementFundId:payerId});
    }
  }
}
function outstandingOverdrafts(){
  const rows=[];for(const cycle of state.cycles)for(const item of cycle.overdrafts||[]){const paid=overdraftSettlementRows(cycle.id,item.sourceFundId).reduce((sum,e)=>sum+e.amountCents,0),refunded=overdraftCorrectionRows(cycle.id,item.sourceFundId).reduce((sum,e)=>sum+e.amountCents,0),outstanding=Math.max(0,item.amountCents-paid+refunded);if(outstanding>0)rows.push({...item,cycleId:cycle.id,cycleStartAt:cycle.startAt,cycleEndAt:cycle.endAt,outstandingCents:outstanding})}return rows.sort((a,b)=>a.cycleStartAt-b.cycleStartAt||a.sourceFundName.localeCompare(b.sourceFundName));
}
function openOverdraftSettlement(cycleId,sourceFundId){
  const overdue=outstandingOverdrafts().find(item=>item.cycleId===cycleId&&item.sourceFundId===sourceFundId);if(!overdue)return showToast('这笔待处理超支已补齐或已更正');
  const choices=[{id:'savings',label:`累计结余 · ${money(savingsBalanceAt())}`,balance:savingsBalanceAt()}];for(const fund of state.funds.filter(f=>!f.disabledAt&&['fixed','increment'].includes(f.type))){const balance=fundBalanceAt(fund,Date.now());if(balance>0)choices.push({id:`fund:${fund.id}`,label:`${fund.name} · ${money(balance)}`,balance})}const usable=choices.filter(item=>item.balance>0);
  $('#overdraftSettleCycleId').value=cycleId;$('#overdraftSettleFundId').value=sourceFundId;$('#overdraftSettleSummary').textContent=`${overdue.sourceFundName} · ${formatRange(overdue.cycleStartAt,overdue.cycleEndAt)} · 尚欠 ${money(overdue.outstandingCents)}。补齐是余额调整，不会记作消费。`;
  $('#overdraftSettleSource').innerHTML=usable.map(item=>`<option value="${escapeHTML(item.id)}">${escapeHTML(item.label)}</option>`).join('');$('#overdraftSettleSource').disabled=!usable.length;$('#overdraftSettleAmount').value=(overdue.outstandingCents/100).toFixed(2);$('#overdraftSettleAmount').max=(overdue.outstandingCents/100).toFixed(2);$('#overdraftSettleForm button[type="submit"]').disabled=!usable.length;$('#overdraftSettleHelp').textContent=usable.length?'可全部或部分补齐。钱包余额会实际减少，累计结余将记录为缺口补齐；没有可用余额时，请先将钱转入可用钱包。':'没有可用的现金钱包或累计结余。先转入余额后再补齐。';openModal('overdraftSettlementModal');
}
function saveOverdraftSettlement(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const cycleId=$('#overdraftSettleCycleId').value,sourceFundId=$('#overdraftSettleFundId').value,overdue=outstandingOverdrafts().find(item=>item.cycleId===cycleId&&item.sourceFundId===sourceFundId),source=$('#overdraftSettleSource').value,amount=centsInput('#overdraftSettleAmount');if(!overdue)return showToast('这笔待处理超支已补齐或已更正');if(amount==null||amount<=0||amount>overdue.outstandingCents)return showToast(`补齐金额须在 0.01 至 ${money(overdue.outstandingCents)} 之间`);
  const now=Date.now(),note=`补齐 ${overdue.sourceFundName} 的历史超支`;if(source==='savings'){if(savingsBalanceAt(now)<amount)return showToast('累计结余余额不足');state.savingsEntries.push({id:newId(),kind:'overdraft-settlement',date:dateISO(new Date(now)),timestamp:now,amountCents:amount,note,sourceCycleId:cycleId,sourceFundId,settlementFundId:'savings'})}else{const payer=getFund(source.slice('fund:'.length));if(!payer||payer.disabledAt||!['fixed','increment'].includes(payer.type))return showToast('请选择可用的钱包');if(fundBalanceAt(payer,now)<amount)return showToast(`${payer.name} 可用余额不足`);addLedger(payer,'overdraft-settlement',amount,note,now,{sourceCycleId:cycleId,sourceFundId,settlementFundId:payer.id})}
  persist();closeModal('overdraftSettlementModal');showToast(`已补齐 ${money(amount)}；余额变化已记录，不计入消费`);
}
function disableFund(id){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const fund=getFund(id);if(!fund||fund.disabledAt)return;const linked=fundDeletionLinks(id),now=Date.now();
  askConfirm('停用并保留钱包？',`${fund.name} 当前余额 ${money(fundBalanceAt(fund,now))}。停用后保留余额和历史，本期已分配额度不变；未来周期不再刷新，${linked.rules.length} 条定时计划会暂停，${linked.occurrences.length+linked.dues.length} 笔已有待确认账单保留。`,()=>{fund.disabledAt=now;if(openCycle())openCycle().surplusExcludedFundIds=[...new Set([...(openCycle().surplusExcludedFundIds||[]),fund.id])];for(const rule of linked.rules){if(rule.active){rule.active=false;rule.disabledByFundAt=now}}persist();closeModal('deleteFundModal');showToast('钱包已停用；余额和待确认账单保留，未来计划已暂停')},'停用钱包');
}
function enableFund(id){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const fund=getFund(id);if(!fund||!fund.disabledAt)return;const planned=allocationTotal()+(fund.type==='fixed'?fund.allowanceCents:fund.type==='increment'?fund.contributionCents:0);if(planned>plannedTakeHomeCents())return showToast(`恢复后下期计划分配会超过月到手工资 ${money(planned-plannedTakeHomeCents())}。请先减少其他钱包额度或调整工资。`);const now=Date.now();fund.disabledAt=null;fund.restoredAt=now;
  for(const rule of state.rules.filter(r=>r.fundId===fund.id&&r.disabledByFundAt)){delete rule.disabledByFundAt;if(rule.frequency==='once'&&rule.nextDueAt<=now){rule.active=false;rule.completedAt=now}else{if(rule.frequency!=='once')while(rule.nextDueAt<=now)rule.nextDueAt=nextRuleDueAt(rule,rule.nextDueAt);rule.active=true;delete rule.stoppedAt}}
  persist();showToast('钱包已恢复；本期额度不补发，下个新周期开始重新参与刷新和计划')
}
function reconcileClosedCycleSurpluses(){
  const settledIds=new Set([...state.entries.filter(e=>e.kind==='surplus-out').map(e=>e.cycleId),...state.savingsEntries.filter(e=>e.kind==='surplus-in').map(e=>e.sourceCycleId)]);
  const cycles=state.cycles.filter(c=>c.endAt!=null&&(Number.isFinite(c.surplusSettledAt)||settledIds.has(c.id))).sort((a,b)=>a.endAt-b.endAt);
  for(const cycle of cycles){if(!Number.isFinite(cycle.surplusSettledAt))cycle.surplusSettledAt=cycle.endAt;if(!cycle.surplusSettlementCycleId){const existing=state.entries.find(e=>e.kind==='surplus-out'&&e.cycleId===cycle.id)||state.savingsEntries.find(e=>e.kind==='surplus-in'&&e.sourceCycleId===cycle.id),successor=state.cycles.find(c=>c.startAt===cycle.endAt);cycle.surplusSettlementCycleId=existing?.settlementCycleId||successor?.id||null}cycle.surplusExcludedFundIds||=[];cycle.overdrafts||=[];refreshFixedSurplusSettlement(cycle)}
}
function recordScheduledAccountCredits(timestamp){
  let changed=false;const scheduledKey=String(timestamp);
  for(const account of state.accounts){const marker=`${account.id}:${scheduledKey}`;if(timestamp<(account.effectiveFromAt||Infinity)||state.accountProcessedKeys.includes(marker))continue;state.accountProcessedKeys.push(marker);changed=true;
    if(account.type==='provident'){const personal=account.monthlyPersonalCents||0,company=account.monthlyCompanyCents||0,total=personal+company;if(total>0)addAccountLedger(account,'provident-credit',total,'每月公积金定期入账',timestamp,{id:`benefit-${account.id}-${scheduledKey}`,personalCents:personal,companyCents:company,scheduledKey})}
    else{const amount=account.monthlyMedicalCents||0;if(amount>0)addAccountLedger(account,'medical-credit',amount,'每月医保账户定期入账',timestamp,{id:`benefit-${account.id}-${scheduledKey}`,scheduledKey})}
  }
  return changed;
}
function reconcileScheduledCycles(now=Date.now()){
  if(!Number.isFinite(state.lastScheduledAt))state.lastScheduledAt=latestPaydayAt(new Date(now));
  if(!Number.isFinite(state.scheduleChangedAt))state.scheduleChangedAt=state.lastScheduledAt;
  let processed=0;
  while(processed<240){
    const next=nextPaydayAfter(Math.max(state.lastScheduledAt,state.scheduleChangedAt));if(next>now)break;
    const cycle=openCycle();
    if(cycle&&next<=cycle.startAt){recordScheduledAccountCredits(next);state.lastScheduledAt=next;processed++;continue}
    const nextCycleId=cycleIdAt(next);if(cycle){sweepFixedSurplus(cycle,next,nextCycleId);cycle.endAt=next}
    const nextCycle=makeCycle(next,'scheduled',String(next));state.cycles.push(nextCycle);addCycleStartEvents(nextCycle,next,false);state.lastScheduledAt=next;processed++;
    recordScheduledAccountCredits(next);
  }
  if(processed>=240)showToast('补齐周期时遇到异常，已停止连续刷新');
  const cycle=openCycle();if(!cycle){const start=latestPaydayAt(new Date(now));const created=makeCycle(start,'recovered');state.cycles.push(created);addCycleStartEvents(created,start,true)}
}

function ruleOccurrenceId(ruleId,dueAt){return `occ-${ruleId}-${Math.trunc(dueAt)}`}
function nextRuleDueAt(rule,fromTimestamp){
  if(rule.frequency==='once')return Infinity;
  const current=new Date(fromTimestamp),step=rule.frequency==='month'?1:rule.frequency==='quarter'?3:12,month=current.getMonth()+step,year=current.getFullYear()+Math.floor(month/12),targetMonth=((month%12)+12)%12;
  return new Date(year,targetMonth,clampDay(year,targetMonth,rule.anchorDay),rule.anchorHour,0,0,0).getTime();
}
function reconcileDueRules(now=Date.now()){
  let changed=false;const due=[];
  for(const rule of state.rules){if(!rule.active||getFund(rule.fundId)?.disabledAt)continue;let guard=0;while(rule.nextDueAt<=now&&guard++<1200){due.push({rule,dueAt:rule.nextDueAt});if(rule.frequency==='once'){rule.active=false;rule.completedAt=now;changed=true;break}rule.nextDueAt=nextRuleDueAt(rule,rule.nextDueAt);changed=true}if(guard>=1200)showToast(`${rule.name} 的计划消费补齐过多，已暂停连续补记`)}
  due.sort((a,b)=>a.dueAt-b.dueAt||a.rule.id.localeCompare(b.rule.id));
  for(const item of due){const {rule,dueAt}=item,id=ruleOccurrenceId(rule.id,dueAt);if(state.occurrences.some(o=>o.id===id))continue;state.occurrences.push({id,ruleId:rule.id,dueAt,amountCents:rule.amountCents,fundId:rule.fundId||null,fundName:rule.fundName,status:'pending',entryId:null});changed=true;
  }
  return changed;
}

function scheduleLabel(timestamp){return timeISO(new Date(timestamp))}
function nextScheduledAt(now=Date.now()){
  const anchor=Math.max(state.lastScheduledAt||latestPaydayAt(new Date(now)),state.scheduleChangedAt||0);
  return nextPaydayAfter(anchor);
}
function currentCycleRange(){const cycle=openCycle();if(!cycle)return{startAt:latestPaydayAt(),endAt:nextScheduledAt()};return{startAt:cycle.startAt,endAt:cycle.endAt||nextScheduledAt()}}
function currentCycleEntries(){const r=currentCycleRange();return state.entries.filter(e=>e.timestamp>=r.startAt&&e.timestamp<r.endAt)}
function rangeForCycle(cycle){return{startAt:cycle.startAt,endAt:cycle.endAt??nextScheduledAt()}}
function syntheticCycleFor(timestamp){
  const d=new Date(timestamp);const start=paydayAt(d.getFullYear(),d.getMonth());if(timestamp<start.getTime())start.setTime(paydayAt(d.getFullYear(),d.getMonth()-1).getTime());const end=paydayAt(start.getFullYear(),start.getMonth()+1);
  return{id:`virtual-${start.getTime()}`,startAt:start.getTime(),endAt:end.getTime(),origin:'history',salaryCents:state.salaryCents,allocations:{}};
}
function cycleForTimestamp(timestamp){
  const real=state.cycles.filter(c=>timestamp>=c.startAt&&(c.endAt==null||timestamp<c.endAt)).sort((a,b)=>b.startAt-a.startAt)[0];return real||syntheticCycleFor(timestamp);
}
function cycleCaption(cycle){const r=rangeForCycle(cycle);return `${timeISO(new Date(r.startAt))} — ${timeISO(new Date(r.endAt))}`}
function reportCycles(){
  const now=Date.now(),entries=allReportEntries(),times=[...entries.map(e=>e.timestamp),...state.cycles.map(c=>c.startAt),now];const min=Math.min(...times);const low=new Date(min);let y=low.getFullYear(),m=low.getMonth()-1;const virtual=[];
  for(let count=0;count<600;count++){
    const start=paydayAt(y,m),end=paydayAt(start.getFullYear(),start.getMonth()+1);if(start.getTime()>now)break;
    const uncovered=entries.some(e=>e.timestamp>=start.getTime()&&e.timestamp<end.getTime()&&!state.cycles.some(c=>e.timestamp>=c.startAt&&(c.endAt==null||e.timestamp<c.endAt)));
    if(uncovered){const nextReal=state.cycles.filter(c=>c.startAt>start.getTime()&&c.startAt<end.getTime()).sort((a,b)=>a.startAt-b.startAt)[0];const earlierEnd=state.cycles.filter(c=>c.endAt!=null&&c.endAt>start.getTime()&&c.endAt<end.getTime()).sort((a,b)=>a.endAt-b.endAt)[0];let virtualStart=earlierEnd?.endAt||start.getTime(),virtualEnd=nextReal?.startAt||end.getTime();if(virtualEnd>virtualStart)virtual.push({id:`virtual-${start.getTime()}`,startAt:virtualStart,endAt:virtualEnd,origin:'history',salaryCents:state.salaryCents,allocations:{}})}
    m++;if(m>11){m=0;y++}
  }
  return [...state.cycles,...virtual].sort((a,b)=>a.startAt-b.startAt);
}
function cycleEntries(cycle){return allReportEntries().filter(e=>cycleForTimestamp(e.timestamp).id===cycle.id)}
function expenseRows(rows){return rows.filter(e=>e.kind==='expense')}
function sumExpenses(rows,fundId=null){return rows.reduce((sum,e)=>sum+(e.kind==='expense'&&(!fundId||e.fundId===fundId)?e.amountCents:0),0)}
function allocationForCycle(cycle,fundId){const a=cycle?.allocations?.[fundId];return a?.amountCents||0}
function plannedTakeHomeCents(){return state.salaryCents}
function allocationTotal(){return state.funds.filter(f=>!f.disabledAt).reduce((s,f)=>s+(f.type==='fixed'?f.allowanceCents:f.type==='increment'?f.contributionCents:0),0)}
function currentCycleAllocation(){const cycle=openCycle();if(!cycle)return 0;let total=Object.entries(cycle.allocations||{}).reduce((sum,[id,a])=>sum+(a?.type==='fixed'?(a.amountCents||0):0),0);for(const [id,a]of Object.entries(cycle.allocations||{}))if(a?.type==='increment')total+=state.entries.filter(e=>e.fundId===id&&e.kind==='increment'&&e.timestamp>=cycle.startAt&&e.timestamp<(cycle.endAt??Infinity)).reduce((sum,e)=>sum+e.amountCents,0);return total}
function entriesForFund(fundId){return state.entries.filter(e=>e.fundId===fundId)}
function fundBalanceAt(fund,timestamp){
  const priority=e=>e.kind==='overdraft-transfer'?-1:['fixed-base','reset'].includes(e.kind)?0:e.kind==='adjust'?1:e.kind==='transfer-in'||e.kind==='savings-in'?2:3;
  const rows=entriesForFund(fund.id).filter(e=>e.timestamp<=timestamp).sort((a,b)=>a.timestamp-b.timestamp||priority(a)-priority(b));
  if(fund.type==='fixed'){
    let base=null,balance=0;
    for(const e of rows){if(e.kind==='fixed-base'||e.kind==='reset'){base=e.timestamp;balance=e.amountCents}else if(base!=null&&e.timestamp>=base){if(e.kind==='expense'||e.kind==='transfer-out'||e.kind==='surplus-out'||e.kind==='overdraft-settlement')balance-=e.amountCents;else if(e.kind==='adjust'||e.kind==='transfer-in'||e.kind==='extra-income'||e.kind==='overdraft-adjust'||e.kind==='overdraft-transfer')balance+=e.amountCents}}
    return base==null?fund.allowanceCents:balance;
  }
  let balance=0;
  for(const e of rows){if(e.kind==='opening'||e.kind==='increment'||e.kind==='topup'||e.kind==='transfer-in'||e.kind==='savings-in'||e.kind==='extra-savings'||e.kind==='overdraft-adjust')balance+=e.amountCents;else if(e.kind==='expense'||e.kind==='transfer-out'||e.kind==='overdraft-settlement')balance-=e.amountCents}
  return balance;
}
function savingsBalanceAt(timestamp=Date.now()){return state.savingsEntries.filter(e=>e.timestamp<=timestamp).reduce((sum,e)=>sum+(e.kind==='surplus-in'||e.kind==='overdraft-adjust'?e.amountCents:e.kind==='expense'||e.kind==='transfer-out'||e.kind==='overdraft-settlement'?-e.amountCents:0),0)}
function accountBalanceAt(account,timestamp=Date.now()){
  return account.openingCents+state.accountEntries.filter(e=>e.accountId===account.id&&e.timestamp<=timestamp).reduce((balance,e)=>balance+(e.kind==='provident-credit'||e.kind==='medical-credit'?e.amountCents:e.kind==='opening'?e.amountCents:-e.amountCents),0);
}
function addAccountLedger(account,kind,amountCents,note='',timestamp=Date.now(),extra={}){
  const row={id:newId(),accountId:account.id,accountName:account.name,kind,date:dateISO(new Date(timestamp)),timestamp,amountCents,note:String(note||''),...extra};state.accountEntries.push(row);return row;
}
function getAccount(id){return state.accounts.find(a=>a.id===id)||null}
function allReportEntries(){
  const accountExpenses=state.accountEntries.filter(e=>e.kind==='expense').map(e=>({id:`account-${e.id}`,accountLedgerId:e.id,accountId:e.accountId,fundId:`account:${e.accountId}`,fundName:`${e.accountName||getAccount(e.accountId)?.name||'账户'}（账户）`,kind:'expense',date:e.date,timestamp:e.timestamp,amountCents:e.amountCents,note:e.note||'账户支出',cycleId:cycleForTimestamp(e.timestamp).id}));
  const savingsExpenses=state.savingsEntries.filter(e=>e.kind==='expense').map(e=>({id:`savings-${e.id}`,savingsEntryId:e.id,fundId:'savings',fundName:'累计结余',kind:'expense',date:e.date,timestamp:e.timestamp,amountCents:e.amountCents,note:e.note||'累计结余支出',cycleId:cycleForTimestamp(e.timestamp).id}));
  return [...state.entries,...accountExpenses,...savingsExpenses];
}
function accountDetailKind(entry){return ({opening:'已储蓄额度', 'provident-credit':'公积金实际到账','medical-credit':'医保实际划入',expense:'账户消费','transfer-out':'提取到钱包'})[entry.kind]||'账户流水'}
function periodSpendForFund(fundId,rows){return sumExpenses(rows,fundId)}
function shortDate(value){if(!validDateString(value))return '日期未知';const d=dateAtNoon(value);return `${d.getMonth()+1}月${d.getDate()}日`}
function formatRange(startAt,endAt){const end=new Date(endAt-1);return `${timeISO(new Date(startAt))} 至 ${timeISO(end)}`}
function typeLabel(type){return type==='fixed'?'每月预算':type==='increment'?'长期储蓄':'会员储值'}
function getFund(id){return state.funds.find(f=>f.id===id)||null}
function fundNameFor(id){return getFund(id)?.name||state.entries.find(e=>e.fundId===id)?.fundName||'已删除钱包'}
function allFundFilters(){const map=new Map();for(const f of state.funds)map.set(f.id,f.name);for(const a of state.accounts)map.set(`account:${a.id}`,`${a.name}（账户）`);for(const e of allReportEntries())if(!map.has(e.fundId))map.set(e.fundId,e.fundName||'已删除钱包');return [...map.entries()]}
function showToast(message,force=false){if(persistenceFailureActive&&!force){persistenceFailureActive=false;return}const t=$('#toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
function openModal(id){const modal=$(`#${id}`);modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.classList.add('modal-open')}
function closeModal(id,force=false){if(persistenceFailureActive&&!force){setTimeout(()=>{persistenceFailureActive=false},0);return false}const modal=$(`#${id}`);modal.classList.remove('open');modal.setAttribute('aria-hidden','true');if(!$('.modal-backdrop.open'))document.body.classList.remove('modal-open');return true}
function askConfirm(title,message,action,label='确认'){
  $('#confirmTitle').textContent=title;$('#confirmMessage').textContent=message;$('#confirmAccept').textContent=label;confirmAction=action;openModal('confirmModal');
}
function setupFieldValues(){return Object.fromEntries(['setupSalary','setupPayday','setupHour','setupFundName','setupFundType','setupAllowance','setupContribution','setupOpening','setupStoredOpening'].map(id=>[id,$(`#${id}`).value]))}
function saveSetupDraft(){
  if(!onboardingNeeded)return;
  setupDraft={version:1,step:setupDraft?.step||1,includeWallet:setupDraft?.includeWallet!==false,fields:setupFieldValues()};
  writeSetupDraft(setupDraft);
}
function restoreSetupDraft(){
  const fields=setupDraft?.fields||{};
  for(const id of ['setupSalary','setupPayday','setupFundName','setupAllowance','setupContribution','setupOpening','setupStoredOpening'])$(`#${id}`).value=typeof fields[id]==='string'?fields[id]:'';
  $('#setupHour').value=typeof fields.setupHour==='string'?fields.setupHour:'0';
  $('#setupFundType').value=['fixed','increment','stored'].includes(fields.setupFundType)?fields.setupFundType:'fixed';
  toggleSetupFundFields();
}
function showSetupMessage(message,error=false){const node=$('#setupError');node.textContent=message;node.classList.toggle('is-error',error)}
function syncTypeChoice(group){
  const select=$(`#${group.dataset.typeGroup}`);if(!select)return;
  $$('[data-type-choice]',group).forEach(button=>{const selected=button.dataset.typeChoice===select.value;button.classList.toggle('selected',selected);button.setAttribute('aria-checked',String(selected));button.disabled=select.disabled;button.tabIndex=selected?0:-1});
}
function bindTypeChoices(){
  $$('[data-type-group]').forEach(group=>{const select=$(`#${group.dataset.typeGroup}`);if(!select)return;group.addEventListener('click',event=>{const button=event.target.closest('[data-type-choice]');if(!button||select.disabled)return;select.value=button.dataset.typeChoice;select.dispatchEvent(new Event('change',{bubbles:true}))});group.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const buttons=$$('[data-type-choice]:not(:disabled)',group),current=buttons.indexOf(document.activeElement);if(!buttons.length)return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[index].click();buttons[index].focus()});select.addEventListener('change',()=>syncTypeChoice(group));syncTypeChoice(group)});
}
function showOnboarding(visible){
  const panel=$('#onboarding'),shell=$('.app-shell');if(!panel||!shell)return;
  panel.hidden=!visible;document.body.classList.toggle('onboarding-open',visible);shell.inert=visible;
  if(visible)shell.setAttribute('aria-hidden','true');else shell.removeAttribute('aria-hidden');
}
function showSetupStep(step,save=true){
  setupDraft={...(setupDraft||{}),version:1,step,includeWallet:setupDraft?.includeWallet!==false,fields:setupFieldValues()};
  $$('.setup-step').forEach((section,index)=>section.hidden=index+1!==step);
  $$('[data-setup-progress]').forEach(node=>node.classList.toggle('active',Number(node.dataset.setupProgress)<=step));
  showSetupMessage('');if(save)writeSetupDraft(setupDraft);
}
function toggleSetupFundFields(){
  const type=$('#setupFundType').value;
  $('#setupFixedFields').hidden=type!=='fixed';$('#setupIncrementFields').hidden=type!=='increment';$('#setupStoredFields').hidden=type!=='stored';
  const group=$('[data-type-group="setupFundType"]');if(group)syncTypeChoice(group);
}
function readSetupSalary(){
  const salaryText=$('#setupSalary').value.trim(),dayText=$('#setupPayday').value.trim(),hourText=$('#setupHour').value.trim();
  const salary=salaryText===''?null:toCents(salaryText),day=dayText===''?NaN:Number(dayText),hour=hourText===''?NaN:Number(hourText);
  if(salary==null||salary<0)throw new Error('请填写有效的每月到手工资');
  if(!Number.isInteger(day)||day<1||day>31)throw new Error('发薪日请填写 1 到 31 日');
  if(!Number.isInteger(hour)||hour<0||hour>23)throw new Error('刷新时间请填写 0 到 23 时');
  return{salaryCents:salary,payday:day,paydayHour:hour};
}
function readSetupFund(){
  const name=$('#setupFundName').value.trim(),type=$('#setupFundType').value;if(!name)throw new Error('请填写首个钱包的名称');
  const readAmount=(id,label)=>{const value=$(id).value.trim(),amount=value===''?null:toCents(value);if(amount==null||amount<0)throw new Error(`请填写有效的${label}`);return amount};
  const fund={id:newId(),name,type,allowanceCents:0,contributionCents:0,openingCents:0,createdAt:Date.now(),color:COLORS[0],disabledAt:null};
  if(type==='fixed')fund.allowanceCents=readAmount('#setupAllowance','每月分配金额');
  else if(type==='increment'){fund.contributionCents=readAmount('#setupContribution','每月自动存入金额');fund.openingCents=readAmount('#setupOpening','已有储蓄余额')}
  else if(type==='stored')fund.openingCents=readAmount('#setupStoredOpening','会员储值余额');
  else throw new Error('请选择有效的钱包类型');
  return fund;
}
function setupAllocation(fund){return fund?.type==='fixed'?fund.allowanceCents:fund?.type==='increment'?fund.contributionCents:0}
function advanceSetup(includeWallet){
  try{
    const salary=readSetupSalary(),fund=includeWallet?readSetupFund():null;
    if(fund&&setupAllocation(fund)>salary.salaryCents)throw new Error('钱包分配超过每月到手工资，请调低分配金额');
    setupDraft={...(setupDraft||{}),version:1,step:3,includeWallet,fields:setupFieldValues()};showSetupSummary(salary,fund);showSetupStep(3);
  }catch(error){showSetupMessage(error.message||'请检查填写内容',true)}
}
function showSetupSummary(salaryConfig,fund){
  const allocated=fund?setupAllocation(fund):0;
  $('#setupSummary').innerHTML=`<div><span>每月到手工资</span><strong>${money(salaryConfig.salaryCents)}</strong></div><div><span>发薪日</span><strong>每月 ${salaryConfig.payday} 日 · ${salaryConfig.paydayHour}:00</strong></div><div><span>首个钱包</span><strong>${fund?`${escapeHTML(fund.name)} · ${typeLabel(fund.type)}`:'稍后添加'}</strong></div><div><span>工资分配</span><strong>${money(allocated)}</strong></div><div class="setup-summary-balance"><span>分配余额</span><strong>${money(salaryConfig.salaryCents-allocated)}</strong></div>`;
}
function startSetup(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  try{
    const salaryConfig=readSetupSalary(),fund=setupDraft?.includeWallet===false?null:readSetupFund(),allocated=setupAllocation(fund);
    if(allocated>salaryConfig.salaryCents)throw new Error('钱包分配超过每月到手工资，请调低分配金额');
    const now=Date.now(),startAt=latestPaydayAt(new Date(now),salaryConfig.payday,salaryConfig.paydayHour);
    state=emptyLedgerState();state.salaryCents=salaryConfig.salaryCents;state.payday=salaryConfig.payday;state.paydayHour=salaryConfig.paydayHour;state.scheduleChangedAt=startAt;state.lastScheduledAt=startAt;state.funds=fund?[fund]:[];state.entries=[];state.cycles=[];
    const cycle=makeCycle(startAt,'setup');state.cycles.push(cycle);addCycleStartEvents(cycle,startAt,true);
    if(fund?.type==='increment'){
      if(fund.openingCents>0)addLedger(fund,'opening',fund.openingCents,'已有储蓄入账',startAt,{cycleId:cycle.id});
      if(fund.contributionCents>0)addLedger(fund,'increment',fund.contributionCents,'首期每月自动存入',startAt,{cycleId:cycle.id});
    }else if(fund?.type==='stored'&&fund.openingCents>0)addLedger(fund,'opening',fund.openingCents,'会员储值卡初始余额',startAt,{cycleId:cycle.id});
    reconcileScheduledCycles();reconcileDueRules();
    if(!persist(false)){setupDraft.step=3;showSetupMessage('账本未能保存，修改已撤销，请重试。',true);return}
    onboardingNeeded=false;clearSetupDraft();showOnboarding(false);render();showToast('账本已准备好');
  }catch(error){
    const message=error.message||'请检查填写内容';
    if(message.includes('每月到手工资')||message.includes('发薪日')||message.includes('刷新时间'))showSetupStep(1);else showSetupStep(2);
    showSetupMessage(message,true);
  }
}
function initOnboarding(){
  const panel=$('#onboarding');if(!panel)return;const hadDraft=Boolean(setupDraft&&(Number(setupDraft.step)>1||Object.entries(setupDraft.fields||{}).some(([key,value])=>!['setupHour','setupFundType'].includes(key)&&String(value||'').trim())));restoreSetupDraft();
  if(!onboardingNeeded){showOnboarding(false);return}
  if(!setupDraft)setupDraft={version:1,step:1,includeWallet:true,fields:setupFieldValues()};
  showOnboarding(true);
  if(setupDraft.step>=3){
    try{const salary=readSetupSalary(),fund=setupDraft.includeWallet===false?null:readSetupFund();if(fund&&setupAllocation(fund)>salary.salaryCents)throw new Error('钱包分配超过工资');showSetupSummary(salary,fund);showSetupStep(3,false)}
    catch(error){const message=error.message||'';showSetupStep(message.includes('工资')||message.includes('发薪日')||message.includes('刷新时间')?1:2,false);showSetupMessage(`初始化草稿需要检查：${message}`,true)}
  }else showSetupStep(setupDraft.step||1,false);
  if(hadDraft&&!$('#setupError').textContent)showSetupMessage('已恢复未完成的初始化');
}
function handleNativeBack(){
  const top=$$('.modal-backdrop.open').at(-1);if(top){closeModal(top.id);return true}
  if(onboardingNeeded){const step=setupDraft?.step||1;if(step>1){showSetupStep(step-1);return true}return false}
  const active=$('.page.active');if(active?.id!=='walletsPage'){showPage('walletsPage');return true}return false;
}
window.handleNativeBack=handleNativeBack;
function eventDescription(entry){
  if(entry.note)return entry.note;
  return ({expense:'支出',topup:'储值卡充值',increment:'每月自动存入',opening:'已储蓄额度',reset:'恢复本期额度','fixed-base':'本期初始额度',adjust:'额度调整','surplus-out':'结余转入累计结余','transfer-out':'转出余额','extra-income':'临时收入','extra-savings':'额外存入','savings-in':'余额转入','overdraft-transfer':'停用钱包缺口转入待处理','overdraft-settlement':'补齐历史超支','overdraft-adjust':'历史超支退款'})[entry.kind]||'账目记录';
}
function eventAmount(entry){if(entry.kind==='expense'||entry.kind==='transfer-out'||entry.kind==='surplus-out'||entry.kind==='overdraft-settlement')return `−${money(entry.amountCents)}`;if(entry.kind==='adjust')return `${entry.amountCents>=0?'+':''}${money(entry.amountCents)}`;if(['topup','increment','opening','transfer-in','savings-in','extra-income','extra-savings','overdraft-adjust','overdraft-transfer'].includes(entry.kind))return `+${money(entry.amountCents)}`;if(entry.kind==='reset')return `重置为 ${money(entry.amountCents)}`;if(entry.kind==='fixed-base')return `额度 ${money(entry.amountCents)}`;return ''}
function renderEntries(rows,canDelete=true){
  if(!rows.length)return '<div class="empty-state">这个范围还没有账目记录。</div>';
  return [...rows].sort((a,b)=>b.timestamp-a.timestamp).map(e=>{
    const fund=getFund(e.fundId),name=e.fundName||fund?.name||'已删除钱包',color=fund?.color||'#82967a',deletable=canDelete&&e.kind==='expense';
    const label=e.subscriptionName?`${e.subscriptionName} · ${eventDescription(e)}`:eventDescription(e);
    return `<div class="record-row"><span class="record-icon" style="background:${color}22;color:${color}">${escapeHTML(name.slice(0,1))}</span><div class="record-main"><div class="record-title">${escapeHTML(label)}</div><div class="record-sub">${escapeHTML(shortDate(e.date))} ${new Date(e.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · ${escapeHTML(name)}</div></div><strong class="record-amount ${e.kind==='expense'?'expense-amount':'positive-amount'}">${eventAmount(e)}</strong>${deletable?`<button class="delete-record" data-delete-entry="${escapeHTML(e.id)}" aria-label="删除${escapeHTML(label)}">删除</button>`:''}</div>`;
  }).join('');
}

function renderWallets(){
  const cycleRangeNow=currentCycleRange(),rows=currentCycleEntries(),salary=state.salaryCents,allocated=currentCycleAllocation(),plannedOver=Math.max(0,allocationTotal()-plannedTakeHomeCents()),currentOver=Math.max(0,allocated-salary),overshoot=Math.max(plannedOver,currentOver);
  $('#homeCycleText').textContent=`发薪周期 ${formatRange(cycleRangeNow.startAt,cycleRangeNow.endAt)}`;
  $('#homeSalary').textContent=money(salary);$('#homeAllocated').textContent=money(allocated);$('#homeUnallocated').textContent=money(salary-allocated);$('#homeSpent').textContent=money(sumExpenses(allReportEntries().filter(e=>e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt)));
  $('#homeSavingsBalance').textContent=money(savingsBalanceAt(Date.now()));
  const warning=$('#allocationWarning');warning.hidden=overshoot===0;warning.textContent=overshoot?`${currentOver?`本月已分配超出月到手工资 ${money(currentOver)}。`:''}${plannedOver?`下期计划超出月到手工资 ${money(plannedOver)}。`:''}请减少钱包额度或调整月到手工资。`:'';
  const walletCards=state.funds.map(f=>{
    const spent=periodSpendForFund(f.id,rows),balance=fundBalanceAt(f,Date.now()),allowance=f.type==='fixed'?f.allowanceCents:f.type==='increment'?f.contributionCents:0,pendingRows=[...state.occurrences.filter(o=>(o.status==='pending'||o.status==='exception')&&o.fundId===f.id),...state.legacyDues.filter(d=>(d.legacyStatus==='pending'||d.legacyStatus==='unbound')&&d.fundId===f.id)],pendingAmount=pendingRows.reduce((sum,row)=>sum+row.amountCents,0);
    let detail='';if(f.type==='fixed'){const budgetRemaining=f.allowanceCents-spent;detail=`<div class="wallet-meta"><span>本月已用 ${money(spent)}</span><span class="${budgetRemaining<0?'over':''}">预算${budgetRemaining<0?'超出':'余量'} ${money(Math.abs(budgetRemaining))}</span></div><div class="wallet-meta"><span>本期额度 ${money(f.allowanceCents)}</span><span>可用余额含转入</span></div>`}
    else if(f.type==='increment'){const opening=state.entries.filter(e=>e.fundId===f.id&&e.kind==='opening'&&e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt).reduce((a,e)=>a+e.amountCents,0),carry=fundBalanceAt(f,cycleRangeNow.startAt-1)+opening,added=state.entries.filter(e=>e.fundId===f.id&&e.kind==='increment'&&e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt).reduce((a,e)=>a+e.amountCents,0),transferred=state.entries.filter(e=>e.fundId===f.id&&['transfer-in','savings-in'].includes(e.kind)&&e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt).reduce((a,e)=>a+e.amountCents,0),extra=state.entries.filter(e=>e.fundId===f.id&&e.kind==='extra-savings'&&e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt).reduce((a,e)=>a+e.amountCents,0);detail=`<div class="wallet-meta multi-meta"><span>已储蓄 ${money(carry)}</span><span>本月自动存入 ${money(added)}</span></div><div class="wallet-meta"><span>本月转入 / 额外存入 ${money(transferred+extra)}</span><span>本月已用 ${money(spent)}</span></div><div class="wallet-meta"><span>累计余额 ${money(balance)}</span><span>每月自动存入 ${money(f.contributionCents)}</span></div>`}
    else detail=`<div class="wallet-meta"><span>本月已用 ${money(spent)}</span><span>会员储值</span></div>`;
    if(pendingRows.length)detail+=`<div class="wallet-meta pending-meta"><span>待确认 ${pendingRows.length} 笔</span><span>合计 ${money(pendingAmount)}</span></div>`;
    const ratio=allowance>0?Math.max(0,Math.min(100,spent/allowance*100)):0;
    return `<article class="wallet-card ${f.disabledAt?'wallet-disabled':''}" style="--wallet-color:${f.color}"><button type="button" class="wallet-main" ${f.disabledAt?`data-wallet-detail="${escapeHTML(f.id)}"`:`data-wallet-id="${escapeHTML(f.id)}"`}><div class="wallet-title-row"><span class="fund-dot" style="background:${f.color}"></span><strong>${escapeHTML(f.name)}</strong><span class="wallet-kind">${typeLabel(f.type)}${f.disabledAt?' · 已停用':''}</span></div><div class="wallet-balance"><strong>${money(balance)}</strong><span>${f.type==='increment'?'已储蓄余额':f.type==='stored'?'储值余额':'可用余额'}</span></div>${f.type==='stored'?'':`<div class="progress-track"><div class="progress-fill" style="width:${ratio}%"></div></div>`}${detail}</button><div class="wallet-actions"><button type="button" data-wallet-detail="${escapeHTML(f.id)}">明细</button><button type="button" data-edit-fund="${escapeHTML(f.id)}">编辑</button><button type="button" class="danger-action" data-delete-fund="${escapeHTML(f.id)}">删除</button><details class="wallet-more"><summary>更多</summary><div class="wallet-more-menu">${f.type==='stored'&&!f.disabledAt?`<button type="button" data-topup-wallet="${escapeHTML(f.id)}">充值</button>`:''}${['fixed','increment'].includes(f.type)&&!f.disabledAt?`<button type="button" data-extra-deposit="${escapeHTML(f.id)}">${f.type==='fixed'?'临时收入':'额外存入'}</button>`:''}${['fixed','increment'].includes(f.type)&&!f.disabledAt?`<button type="button" data-balance-transfer="fund:${escapeHTML(f.id)}">转给其他钱包</button>`:''}<button type="button" data-${f.disabledAt?'enable':'disable'}-fund="${escapeHTML(f.id)}">${f.disabledAt?'恢复钱包':'停用钱包'}</button></div></details></div></article>`;
  });
  const accounts=renderAccounts(),surplus=savingsBalanceAt(Date.now()),surplusSpent=state.savingsEntries.filter(e=>e.kind==='expense'&&e.timestamp>=cycleRangeNow.startAt&&e.timestamp<cycleRangeNow.endAt).reduce((a,e)=>a+e.amountCents,0),surplusAdded=state.savingsEntries.filter(e=>e.kind==='surplus-in'&&e.settlementCycleId===openCycle()?.id).reduce((a,e)=>a+e.amountCents,0);
  const savingsCard=`<article class="wallet-card savings-container"><button type="button" class="wallet-main" data-savings-expense><div class="wallet-title-row"><span class="account-badge">盈</span><strong>累计结余</strong><span class="wallet-kind">历月结余</span></div><div class="wallet-balance"><strong>${money(surplus)}</strong><span>${surplus<0?'待补差额（历史账单修正）':'可用余额'}</span></div><div class="wallet-meta"><span>本月转入结余 ${money(surplusAdded)}</span><span>本月已用 ${money(surplusSpent)}</span></div></button><div class="wallet-actions"><button type="button" data-savings-detail>明细</button><button type="button" data-balance-transfer="savings">转入长期储蓄</button></div></article>`;
  const noWallets=state.funds.length===0;$('#fundGrid').classList.toggle('wallet-grid-empty',noWallets);
  $('#fundGrid').innerHTML=[...(noWallets?['<div class="empty-state empty-wallet-state"><strong>还没有钱包</strong><span>创建第一个钱包后，就能从卡片直接记账。</span></div>']:[]),...walletCards,...accounts,savingsCard].join('');
  renderHomePending();
  renderHomeOverdrafts();
  renderLegacyWarning();
}

function renderAccounts(){
  const range=currentCycleRange(),now=Date.now();
  return state.accounts.map(a=>{const credited=state.accountEntries.filter(e=>e.accountId===a.id&&['provident-credit','medical-credit'].includes(e.kind)&&e.scheduledKey&&e.timestamp>=range.startAt&&e.timestamp<Math.min(range.endAt,now+1)).reduce((sum,e)=>sum+e.amountCents,0);return `<article class="wallet-card account-wallet-card"><button type="button" class="wallet-main" data-account-action="expense" data-account-id="${escapeHTML(a.id)}"><div class="wallet-title-row"><span class="account-badge">${a.type==='provident'?'公':'医'}</span><strong>${escapeHTML(a.name)}</strong><span class="wallet-kind">${a.type==='provident'?'公积金账户':'医保个人账户'}</span></div><div class="wallet-balance"><strong>${money(accountBalanceAt(a))}</strong><span>账户余额</span></div><div class="wallet-meta"><span>本月自动登记 ${money(credited)}</span><span>下次 ${scheduleLabel(nextScheduledAt())}</span></div></button><div class="wallet-actions"><button type="button" data-account-action="credit" data-account-id="${escapeHTML(a.id)}">登记/修正到账</button><button type="button" data-account-action="expense" data-account-id="${escapeHTML(a.id)}">消费</button>${a.type==='provident'?`<button type="button" data-account-action="transfer" data-account-id="${escapeHTML(a.id)}">提取到钱包</button>`:''}<button type="button" data-account-detail="${escapeHTML(a.id)}">明细</button><button type="button" data-account-edit="${escapeHTML(a.id)}">管理</button></div></article>`});
}
function renderLegacyWarning(){
  const due=state.legacyDues.filter(d=>d.legacyStatus==='unbound'||d.legacyStatus==='pending').length,plans=state.legacySubscriptions.filter(s=>!s.boundAt).length,pending=state.occurrences.filter(o=>o.status==='pending'||o.status==='exception').length,total=due+plans+pending,node=$('#legacyWarning');node.hidden=!total;node.innerHTML=total?`${pending?`有 ${pending} 笔计划消费待确认。`:''}${due+plans?`旧版本还有 ${due+plans} 项待处理。`:''}<button type="button" data-home-open-legacy>在钱包明细处理中</button>`:'';
}
function renderHomePending(){
  const occurrences=state.occurrences.filter(o=>o.status==='pending'||o.status==='exception'),dues=state.legacyDues.filter(d=>d.legacyStatus==='unbound'||d.legacyStatus==='pending');
  const rows=[...occurrences.map(o=>({id:o.id,type:'occurrence',name:state.rules.find(r=>r.id===o.ruleId)?.name||o.fundName||'计划消费',dueAt:o.dueAt,amountCents:o.amountCents,fundId:o.fundId})),...dues.map(d=>({id:d.id,type:'legacy',name:d.subscriptionName,dueAt:dateAtNoon(d.dueDate).getTime(),amountCents:d.amountCents,fundId:d.fundId}))].sort((a,b)=>a.dueAt-b.dueAt||a.id.localeCompare(b.id));
  const hasActiveFund=state.funds.some(f=>!f.disabledAt);$('#homePendingList').innerHTML=rows.length?rows.map(row=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(row.name)}</strong><span>${scheduleLabel(row.dueAt)} · 尚未扣款 · ${money(row.amountCents)}${row.fundId&&getFund(row.fundId)?` · ${escapeHTML(getFund(row.fundId).name)}`:' · 待选择钱包'}</span></div><div class="subscription-actions"><button type="button" class="primary-button compact" data-handle-pending="${escapeHTML(row.id)}" data-pending-type="${row.type}" ${hasActiveFund?'':'disabled'}>确认账单</button><button type="button" class="secondary-button compact" data-pending-cancel data-record-id="${escapeHTML(row.id)}" data-record-type="${row.type}">取消</button></div></article>`).join(''):'<div class="empty-state">当前没有待确认账单。</div>';
}
function renderHomeOverdrafts(){
  const rows=outstandingOverdrafts(),total=rows.reduce((sum,row)=>sum+row.outstandingCents,0),pending=state.occurrences.filter(row=>row.status==='pending'||row.status==='exception').length+state.legacyDues.filter(row=>row.legacyStatus==='pending'||row.legacyStatus==='unbound').length;
  $('#homeOverdraftTotal').textContent=money(total);$('#homeOverdraftSection').hidden=!rows.length;
  $('#homeOverdraftList').innerHTML=rows.map(row=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(row.sourceFundName)} · ${money(row.outstandingCents)}</strong><span>${formatRange(row.cycleStartAt,row.cycleEndAt)} · 历史缺口，不计入消费</span></div><div class="subscription-actions"><button type="button" class="primary-button compact" data-overdraft-settle="${escapeHTML(row.cycleId)}" data-overdraft-source="${escapeHTML(row.sourceFundId)}">处理缺口</button></div></article>`).join('')||'<div class="empty-state">当前没有待处理超支。</div>';
  const task=$('#homeTaskLink');task.hidden=!pending&&!rows.length;task.textContent=[pending?`待确认账单 ${pending} 笔`:'',rows.length?`待处理超支 ${money(total)}`:''].filter(Boolean).join(' · ');
}

function reportYears(){const years=new Set([new Date().getFullYear()]);for(const c of state.cycles)years.add(new Date(c.startAt).getFullYear());for(const e of allReportEntries())years.add(new Date(cycleForTimestamp(e.timestamp).startAt).getFullYear());return [...years].sort((a,b)=>b-a)}
function cycleOptionText(c){const r=rangeForCycle(c);const active=openCycle()?.id===c.id;return `${active?'本月 · ':''}${new Date(c.startAt).getFullYear()}/${String(new Date(c.startAt).getMonth()+1).padStart(2,'0')} · ${formatRange(r.startAt,r.endAt)}`}
function selectedReportCycle(){const options=reportCycles();return options.find(c=>c.id===selectedCycleId)||openCycle()||options.at(-1)}
function payrollMonthGroups(year){
  const groups=Array.from({length:12},(_,i)=>({year,month:i,entries:[],cycles:[]}));
  for(const c of reportCycles()){const d=new Date(c.startAt);if(d.getFullYear()===year)groups[d.getMonth()].cycles.push(c)}
  for(const e of allReportEntries()){const d=new Date(cycleForTimestamp(e.timestamp).startAt);if(d.getFullYear()===year)groups[d.getMonth()].entries.push(e)}
  return groups;
}
function reportContext(){
  const now=new Date();
  if(selectedReport==='today'){const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);return{title:'今日',caption:`${dateISO(now)} · 自然日`,entries:allReportEntries().filter(e=>e.timestamp>=start.getTime()&&e.timestamp<end.getTime()),cycles:[cycleForTimestamp(now.getTime())],startAt:start.getTime(),endAt:end.getTime(),kind:'range'}}
  if(selectedReport==='week'){const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-((start.getDay()+6)%7));const end=new Date(start);end.setDate(end.getDate()+7);return{title:'本周',caption:`${dateISO(start)} — ${dateISO(new Date(end.getTime()-1))} · 周一至周日`,entries:allReportEntries().filter(e=>e.timestamp>=start.getTime()&&e.timestamp<end.getTime()),cycles:[cycleForTimestamp(now.getTime())],startAt:start.getTime(),endAt:end.getTime(),kind:'range'}}
  if(selectedReport==='year'){
    const groups=payrollMonthGroups(selectedYear),rows=groups.flatMap(g=>g.entries);return{title:'本年度',caption:`${selectedYear} 年 · 按发薪月份归属（周期起始月份）`,entries:rows,groups,cycles:groups.flatMap(g=>g.cycles),kind:'year'};
  }
  if(selectedReport==='paymonth'){
    const groups=payrollMonthGroups(selectedYear),group=groups.find(g=>g.month===selectedMonthIndex)||groups[0];return{title:`${selectedYear}年${group.month+1}月发薪月`,caption:'该月按周期起始月份归属；包括该月内手动新开的周期。',entries:group.entries,cycles:group.cycles,kind:'paymonth',group};
  }
  const cycle=selectedReport==='history'?(reportCycles().filter(c=>c.startAt<(openCycle()?.startAt||Infinity)).find(c=>c.id===selectedCycleId)||reportCycles().filter(c=>c.startAt<(openCycle()?.startAt||Infinity)).at(-1)):selectedReportCycle();
  const active=openCycle()?.id===cycle?.id;return{title:active?'本月':selectedReport==='history'?'历史周期':'发薪月份',caption:cycle?`${cycleCaption(cycle)}${active?' · 发薪周期':''}`:'暂无可查看周期',entries:cycle?cycleEntries(cycle):[],cycles:cycle?[cycle]:[],cycle,kind:'cycle'};
}
function renderReportContextSelect(){
  const select=$('#reportContextSelect');select.innerHTML='';
  if(selectedReport==='year'){
    for(const y of reportYears())select.add(new Option(`${y} 年发薪月份`,String(y),y===selectedYear,y===selectedYear));select.hidden=false;select.setAttribute('aria-label','选择年度');
  }else if(selectedReport==='month'||selectedReport==='history'){
    let cycles=reportCycles();if(selectedReport==='history')cycles=cycles.filter(c=>c.startAt<(openCycle()?.startAt||Infinity));cycles=cycles.sort((a,b)=>b.startAt-a.startAt);
    if(!cycles.length){select.hidden=true;return}
    if(!cycles.some(c=>c.id===selectedCycleId))selectedCycleId=selectedReport==='month'?(openCycle()?.id||cycles[0].id):cycles[0].id;
    for(const c of cycles)select.add(new Option(cycleOptionText(c),c.id,c.id===selectedCycleId,c.id===selectedCycleId));select.hidden=false;select.setAttribute('aria-label',selectedReport==='month'?'选择发薪月份':'选择历史周期');
  }else select.hidden=true;
}
function relevantFundIds(entries){const ids=new Set(state.funds.map(f=>f.id));for(const a of state.accounts)ids.add(`account:${a.id}`);ids.add('savings');for(const e of entries)ids.add(e.fundId);return [...ids]}
function cycleSpend(fundId,cycles,entries){return sumExpenses(entries,fundId)}
function allocationAcrossCycles(fundId,cycles){return cycles.reduce((sum,c)=>sum+allocationForCycle(c,fundId),0)}
function endTimestamp(context){if(context.kind==='year'||context.kind==='paymonth')return context.cycles.length?Math.max(...context.cycles.map(c=>rangeForCycle(c).endAt))-1:Date.now();return context.endAt??(context.cycles.length?rangeForCycle(context.cycles.at(-1)).endAt-1:Date.now())}
function renderBreakdown(context,filteredEntries){
  const ids=relevantFundIds(filteredEntries),cycles=context.cycles?.length?context.cycles:[cycleForTimestamp(Date.now())],endAt=endTimestamp(context);
  $('#walletBreakdown').innerHTML=ids.map(id=>{
    const accountId=id.startsWith('account:')?id.slice(8):null,account=accountId?getAccount(accountId):null,fund=getFund(id),specialSavings=id==='savings',name=account?`${account.name}（账户）`:specialSavings?'累计结余':fund?.name||fundNameFor(id),color=fund?.color||'#82967a',spent=cycleSpend(id,cycles,filteredEntries),type=specialSavings?'savings':fund?.type||'fixed',allocated=allocationAcrossCycles(id,cycles),balance=account?accountBalanceAt(account,endAt):specialSavings?savingsBalanceAt(endAt):fund?fundBalanceAt(fund,endAt):0;
    const quotaKnown=cycles.every(c=>Object.hasOwn(c.allocations||{},id));let right='';if(account)right=`账户余额 ${money(balance)}`;else if(specialSavings||type==='increment'||type==='stored')right=`长期余额 ${money(balance)}`;else if(!quotaKnown)right='历史额度未记录';else{const remaining=allocated-spent;right=remaining<0?`预算超出 ${money(-remaining)}`:`预算余量 ${money(remaining)}`}
    return `<button type="button" class="breakdown-row" data-breakdown-fund="${escapeHTML(id)}"><span class="fund-dot" style="background:${color}"></span><span class="breakdown-name">${escapeHTML(name)}${account?'<small>账户支出</small>':fund?`<small>${typeLabel(type)}</small>`:'<small>已删除钱包</small>'}</span><strong>${money(spent)}</strong><span class="breakdown-balance ${right.startsWith('超出')?'over':''}">${right}</span></button>`;
  }).join('')||'<div class="empty-state">这个范围还没有钱包支出。</div>';
}
function dailyGroups(entries){const map=new Map();for(const e of entries){const k=e.date;if(!map.has(k))map.set(k,[]);map.get(k).push(e)}return [...map.entries()].sort((a,b)=>b[0].localeCompare(a[0]))}
function renderTimeline(context,entries){
  const timeline=$('#timelineList'),section=$('#timelineSection');timeline.innerHTML='';$('#timelineTitle').textContent=context.kind==='year'?'按发薪月份':context.kind==='paymonth'?'按日查看':'按日查看';
  if(context.kind==='year'){
    section.hidden=false;$('#timelineHint').textContent='按周期起始月份归属；点月份查看该发薪月';
    timeline.innerHTML=context.groups.map(g=>{const rows=g.entries.filter(e=>entries.includes(e)),spent=sumExpenses(rows),count=expenseRows(rows).length;return `<button type="button" class="timeline-row" data-payroll-month="${g.month}"><span class="timeline-date">${selectedYear}年${g.month+1}月<span>发薪月份</span></span><span class="timeline-info">${count} 笔支出</span><strong>${money(spent)}</strong><span class="timeline-arrow">›</span></button>`}).join('');return;
  }
  section.hidden=false;$('#timelineHint').textContent='点击日期查看当天逐笔记录';
  if(context.kind==='range'||context.kind==='cycle'||context.kind==='paymonth'){
    const groups=dailyGroups(entries);timeline.innerHTML=groups.map(([day,rows])=>`<button type="button" class="timeline-row ${selectedDay===day?'selected':''}" data-day-filter="${day}"><span class="timeline-date">${shortDate(day)}<span>${new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN',{weekday:'short'})}</span></span><span class="timeline-info">${expenseRows(rows).length} 笔支出</span><strong>${money(sumExpenses(rows))}</strong><span class="timeline-arrow">›</span></button>`).join('')||'<div class="empty-state">没有逐日记录。</div>';
  }
}
function renderReports(){
  renderReportContextSelect();const context=reportContext(),filter=$('#reportFundFilter').value||'all';const filtered=filter==='all'?context.entries:context.entries.filter(e=>e.fundId===filter);
  $('#reportTitle').textContent=context.title;$('#reportCaption').textContent=context.caption;$('#reportTotalLabel').textContent=`${context.kind==='year'?'本年度':context.kind==='range'?(context.title==='今日'?'今日':'本周'):context.kind==='paymonth'?'发薪月份':context.kind==='cycle'?'本月':'历史周期'}支出（含公积金、医保）`;$('#reportTotal').textContent=money(sumExpenses(filtered));const accountSpent=sumExpenses(filtered.filter(e=>String(e.fundId).startsWith('account:'))),walletSpent=sumExpenses(filtered.filter(e=>!String(e.fundId).startsWith('account:')));$('#reportExpenseSplit').textContent=`钱包 ${money(walletSpent)} · 公积金 / 医保 ${money(accountSpent)}`;$('#reportCount').textContent=`${expenseRows(filtered).length} 笔支出`;
  const breakdownTitle=$('#breakdownTitle');breakdownTitle.textContent='钱包与账户支出';$('#breakdownHint').textContent=context.kind==='year'?'按发薪月份汇总 · 支出与额度余量':context.kind==='cycle'?'本月额度、支出与余额':'支出和可用额度';
  renderBreakdown(context,filtered);renderTimeline(context,filtered);
  let shown=filtered;if(selectedDay)shown=shown.filter(e=>e.date===selectedDay);$('#clearDayFilter').hidden=!selectedDay;$('#transactionsTitle').textContent=selectedDay?`${shortDate(selectedDay)} 明细`:'逐笔记录';$('#recordsSummary').textContent=`${shown.length} 条账目 · 支出 ${money(sumExpenses(shown))}`;$('#allRecordsList').innerHTML=renderEntries(shown,true);
  $$('#reportTabs button').forEach(b=>b.classList.toggle('selected',b.dataset.report===selectedReport||selectedReport==='paymonth'&&b.dataset.report==='year'));
  const options=allFundFilters(),sel=$('#reportFundFilter'),before=sel.value||'all';sel.innerHTML='<option value="all">全部钱包</option>'+options.map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('');sel.value=options.some(([id])=>id===before)?before:'all';
}

function renderSettings(force=false){
  const form=$('#salaryForm');if(force||form.dataset.loaded!=='true'){if(form.dataset.dirty==='true')showToast('工资设置已重新载入');$('#salaryInput').value=(state.salaryCents/100).toFixed(2);$('#paydayInput').value=state.payday;$('#paydayHourInput').value=state.paydayHour;form.dataset.loaded='true';form.dataset.dirty='false'}
  $('#dataStorageDescription').textContent=nativeStorage?'保存在本机，可导出 JSON 备份':'保存在此浏览器，可导出 JSON 备份';
  $('#privacyNote').textContent=nativeStorage?'花在哪 2.0.1 · 数据保存在本机':'数据只保存在此浏览器 · 不需要注册 · 花在哪 2.0.1';
  const net=state.salaryCents,total=allocationTotal(),current=currentCycleAllocation(),over=total-net,currentOver=current-net;
  $('#salaryAllocationHelp').textContent=over>0||currentOver>0?`${currentOver>0?`本期已分配超出月到手工资 ${money(currentOver)}。`:''}${over>0?`下期计划分配超出月到手工资 ${money(over)}。`:''}请削减钱包额度或调整月到手工资。`:`本期已分配 ${money(current)}；下期计划分配 ${money(total)}，预计未分配 ${money(net-total)}。`;
  $('#nextRefreshText').textContent=`下次自动刷新：${scheduleLabel(nextScheduledAt())}。应用重新打开时会补齐漏过的发薪周期和到期账单。`;
  $('#backupStatus').textContent=state.lastExportAt?`上次导出备份：${timeISO(new Date(state.lastExportAt))}`:'尚未导出备份';
}
function render(){
  updateStorageWarning();renderWallets();renderReports();renderSettings();if($('#detailModal').classList.contains('open'))renderWalletDetail();if($('#accountDetailModal').classList.contains('open'))refreshAccountDetail();if($('#savingsDetailModal').classList.contains('open'))refreshSavingsDetail();
}

function showPage(id){$$('.page').forEach(p=>p.classList.toggle('active',p.id===id));$$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===id));window.scrollTo({top:0,behavior:'smooth'})}
function openEntry(fundId,kind='expense'){
  const fund=getFund(fundId);if(!fund)return showToast('这个钱包已经删除');if(fund.disabledAt)return showToast('这个钱包已停用；恢复后才能记入新账目');if(kind==='topup'&&fund.type!=='stored')return showToast('只有会员储值可以充值');
  $('#entryForm').reset();$('#entryFund').value=fund.id;$('#entryTitle').textContent=fund.name;$('#entryEyebrow').textContent=kind==='topup'?'储值卡充值':`当前余额 ${money(fundBalanceAt(fund,Date.now()))}`;$('#entryAmountLabel').textContent=kind==='topup'?'本次充值金额':'本次用了多少';$('#entryForm').dataset.kind=kind;openModal('entryModal');setTimeout(()=>$('#entryAmount').focus(),150);
}
function openSurplusExpense(){if(savingsBalanceAt(Date.now())<=0)return showToast('累计结余当前没有可用余额');$('#entryForm').reset();$('#entryFund').value='';$('#entryTitle').textContent='累计结余';$('#entryEyebrow').textContent=`当前余额 ${money(savingsBalanceAt(Date.now()))}`;$('#entryAmountLabel').textContent='本次用了多少';$('#entryForm').dataset.kind='surplus-expense';openModal('entryModal');setTimeout(()=>$('#entryAmount').focus(),150)}
function refreshSavingsDetail(){const rows=state.savingsEntries.slice().sort((a,b)=>b.timestamp-a.timestamp);$('#savingsDetailBalance').innerHTML=`<span>当前余额</span><strong>${money(savingsBalanceAt(Date.now()))}</strong><small>新周期归集每月预算钱包的正余额；历史缺口补齐与退款也会列在这里</small>`;$('#savingsDetailRecords').innerHTML=rows.map(e=>{const positive=e.kind==='surplus-in'||e.kind==='overdraft-adjust',expense=e.kind==='expense',settlement=e.kind==='overdraft-settlement',label=e.note||(positive?`${e.sourceFundName||'钱包'}结余转入`:expense?'支出':settlement?'补齐历史超支':'转入钱包');return `<div class="record-row"><span class="record-icon paid-icon">${positive?'+':expense||settlement?'−':'↗'}</span><div class="record-main"><div class="record-title">${escapeHTML(label)}</div><div class="record-sub">${shortDate(e.date)} ${new Date(e.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}${e.sourceFundName?` · ${escapeHTML(e.sourceFundName)}`:''}${settlement?' · 余额调整，不计入消费':''}</div></div><strong class="record-amount ${positive?'positive-amount':'expense-amount'}">${positive?'+':'−'}${money(e.amountCents)}</strong>${expense?`<button class="delete-record" data-delete-entry="savings-${escapeHTML(e.id)}">删除</button>`:''}</div>`}).join('')||'<div class="empty-state">还没有结余记录。新周期开始时，会自动归集每月预算钱包的正余额。</div>'}
function openSavingsDetail(){refreshSavingsDetail();openModal('savingsDetailModal')}
function balanceTransferSource(){
  const source=$('#transferSource').value,[kind,id]=source.split(':'),fund=kind==='fund'?getFund(id):null;
  if(kind==='fund'&&(!fund||fund.disabledAt))return{source,kind,id,fund:null,balance:0,label:fund?'来源钱包已停用':'来源钱包已删除',targetType:null};
  if(kind!=='fund'&&kind!=='savings')return{source,kind,id,fund:null,balance:0,label:'来源无效',targetType:null};
  const balance=kind==='savings'?savingsBalanceAt(Date.now()):fundBalanceAt(fund,Date.now()),targetType=kind==='savings'?'increment':fund.type==='fixed'?'fixed':fund.type==='increment'?'increment':null;
  return{source,kind,id,fund,balance,label:kind==='savings'?'累计结余':fund.name,targetType};
}
function openBalanceTransfer(source){
  const [kind,id='']=source.split(':'),sourceFund=kind==='fund'?getFund(id):null;if(kind==='fund'&&!sourceFund)return showToast('来源钱包已删除');if(sourceFund?.disabledAt)return showToast('停用钱包为只读状态，恢复后才能转出余额');if(kind!=='fund'&&kind!=='savings')return showToast('余额来源无效');if(kind==='fund'&&!['fixed','increment'].includes(sourceFund.type))return showToast('只有每月预算钱包和长期储蓄钱包可转出余额');
  const balance=kind==='savings'?savingsBalanceAt(Date.now()):fundBalanceAt(sourceFund,Date.now());if(balance<=0)return showToast('来源余额不足');
  const targetType=kind==='fund'&&sourceFund.type==='fixed'?'fixed':'increment',targets=state.funds.filter(f=>!f.disabledAt&&f.type===targetType&&(kind!=='fund'||f.id!==sourceFund.id));if(!targets.length)return showToast(targetType==='fixed'?'没有可转入的其他每月预算钱包':'没有其他长期储蓄钱包可接收这笔余额');
  $('#transferForm').reset();$('#transferSource').value=source;$('#transferSourceBalance').textContent=`${kind==='savings'?'累计结余':sourceFund.name} · 可转 ${money(balance)}`;$('#transferTarget').innerHTML=targets.map(f=>`<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)} · ${typeLabel(f.type)}</option>`).join('');$('#transferAmount').max=(balance/100).toFixed(2);$('#transferAmount').value='';openModal('transferModal')
}
function saveBalanceTransfer(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const source=balanceTransferSource(),target=getFund($('#transferTarget').value),amount=centsInput('#transferAmount');if(!source.fund&&source.kind==='fund'||source.targetType==null)return showToast('来源钱包已删除或停用');if(amount==null||amount<=0||!target||target.disabledAt)return showToast('请选择启用中的目标钱包并输入有效金额');if(amount>source.balance)return showToast('转入金额不能超过来源可用余额');if(target.type!==source.targetType||(source.fund&&target.id===source.fund.id))return showToast('这类余额不能转入所选钱包');
  const now=Date.now(),transferId=newId();if(source.kind==='savings'){state.savingsEntries.push({id:`savings-transfer-${transferId}`,kind:'transfer-out',timestamp:now,date:dateISO(new Date(now)),amountCents:amount,note:`转入 ${target.name}`,targetFundId:target.id,targetFundName:target.name,transferId});addLedger(target,'savings-in',amount,`从累计结余转入`,now,{transferId,sourceFundId:'savings',sourceFundName:'累计结余'})}
  else if(source.fund.type==='increment'){addLedger(source.fund,'transfer-out',amount,`转入 ${target.name}`,now,{transferId,targetFundId:target.id,targetFundName:target.name});addLedger(target,'savings-in',amount,`从 ${source.fund.name} 转入`,now,{transferId,sourceFundId:source.fund.id,sourceFundName:source.fund.name})}
  else{addLedger(source.fund,'transfer-out',amount,`转入 ${target.name}`,now,{transferId,targetFundId:target.id,targetFundName:target.name});addLedger(target,'transfer-in',amount,`从 ${source.fund.name} 转入`,now,{transferId,sourceFundId:source.fund.id,sourceFundName:source.fund.name})}
  persist();closeModal('transferModal');showToast('余额转入已记录；钱包额度计划未改变')
}
function transferAllAvailable(){const source=balanceTransferSource();if(source.targetType==null||source.balance<=0)return showToast('来源余额不足');$('#transferAmount').value=(source.balance/100).toFixed(2)}
function openExtraDeposit(id){const fund=getFund(id);if(!fund||fund.disabledAt||!['fixed','increment'].includes(fund.type))return;$('#extraDepositForm').reset();const choices=state.funds.filter(item=>!item.disabledAt&&['fixed','increment'].includes(item.type));$('#extraDepositFund').innerHTML=choices.map(item=>`<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');$('#extraDepositFund').value=fund.id;$('#extraDepositTitle').textContent=fund.type==='fixed'?'临时收入':'额外存入长期储蓄';$('#extraDepositAmount').value='';openModal('extraDepositModal')}
function saveExtraDeposit(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const fund=getFund($('#extraDepositFund').value),amount=centsInput('#extraDepositAmount'),note=$('#extraDepositNote').value.trim();if(!fund||fund.disabledAt||!['fixed','increment'].includes(fund.type)||amount==null||amount<=0)return showToast('请选择启用的钱包并输入有效金额');addLedger(fund,fund.type==='fixed'?'extra-income':'extra-savings',amount,note||(fund.type==='fixed'?'临时收入':'额外存入长期储蓄'));persist();closeModal('extraDepositModal');showToast('额外入账已记录，不会改变每期工资分配')
}
function toggleFundFields(){
  const type=$('#fundType').value,editing=Boolean($('#fundId').value);
  const groups=[['fixed','#fundAllowanceField'],['increment','#fundIncrementField']];
  for(const [key,selector]of groups){const group=$(selector),visible=type===key;group.hidden=!visible;$$('input',group).forEach(input=>{input.disabled=!visible;input.required=visible&&input.id==='fundAllowance'})}
  const storedGroup=$('#fundStoredField'),storedVisible=type==='stored';storedGroup.hidden=!storedVisible;$$('input',storedGroup).forEach(input=>{input.disabled=!storedVisible||editing;input.required=storedVisible&&!editing});
  $('#fundType').disabled=editing;
  const typeChoiceGroup=$('[data-type-group="fundType"]');if(typeChoiceGroup)syncTypeChoice(typeChoiceGroup);
  $('#fundOpening').disabled=editing||type!=='increment';$('#fundStoredBalance').disabled=editing;
  $('#fundOpeningHelp').textContent=editing?'已储蓄额度只在创建时填写；已有余额按账本流水保留。':'钱包创建前已经攒下的钱，不包含每月自动存入的金额。';
  const storedLabel=$('#fundStoredBalanceLabel');if(storedLabel)storedLabel.textContent='会员储值余额';
  $('#fundStoredHelp').textContent=editing?'编辑钱包不会改写已有余额；会员储值卡请用充值。':'会员储值卡初始余额；之后用钱包卡片的充值操作增加余额。';
}
function openFund(fund=null){
  $('#fundForm').reset();$('#fundId').value=fund?.id||'';$('#fundModalTitle').textContent=fund?'编辑钱包':'添加钱包';$('#fundName').value=fund?.name||'';$('#fundType').value=fund?.type||'fixed';$('#fundAllowance').value=fund?fund.allowanceCents/100:'';$('#fundIncrement').value=fund?(fund.contributionCents/100).toFixed(2):'0.00';$('#fundOpening').value=fund?fund.openingCents/100:'';$('#fundStoredBalance').value=fund?fund.openingCents/100:'';selectedColor=fund?.color||COLORS[state.funds.length%COLORS.length];$('#colorOptions').innerHTML=COLORS.map(c=>`<button type="button" class="color-choice ${c===selectedColor?'selected':''}" data-color="${c}" style="background:${c}" aria-label="选择颜色"></button>`).join('');toggleFundFields();openModal('fundModal');
}
function createFund(form){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  const name=$('#fundName').value.trim(),type=$('#fundType').value,id=$('#fundId').value;
  const existing=getFund(id);if(!name)return showToast('请输入钱包名称');if(!['fixed','increment','stored'].includes(type))return showToast('请选择钱包类型');
  let allowance=existing?.allowanceCents||0,contribution=existing?.contributionCents||0,opening=existing?.openingCents||0;
  if(type==='fixed'){allowance=centsInput('#fundAllowance');if(allowance==null||allowance<0)return showToast('请输入有效的每月预算金额')}
  if(type==='increment'){contribution=centsInput('#fundIncrement');if(contribution==null||contribution<0)return showToast('请输入有效的每月自动存入金额');if(!existing){opening=centsInput('#fundOpening');if(opening==null||opening<0)return showToast('请输入有效的已储蓄额度')}}
   if(type==='stored'&&!existing){opening=centsInput('#fundStoredBalance');if(opening==null||opening<0)return showToast('请输入有效的储值余额')}
  const proposed={id:id||newId(),name,type,allowanceCents:allowance,contributionCents:contribution,openingCents:opening,createdAt:existing?.createdAt||Date.now(),color:selectedColor};
  const planned=state.funds.filter(f=>f.id!==id&&!f.disabledAt).reduce((sum,f)=>sum+(f.type==='fixed'?f.allowanceCents:f.type==='increment'?f.contributionCents:0),0)+(!existing?.disabledAt?(type==='fixed'?allowance:type==='increment'?contribution:0):0);
  const nextSalary=plannedTakeHomeCents();if(planned>nextSalary)return showToast(`下期计划分配会超过预计到手 ${money(planned-nextSalary)}。请削减其他钱包额度或调整工资。`);
  const cycle=openCycle(),current=cycle?currentCycleAllocation():0;let proposedCurrent=current;
  if(existing?.type==='fixed'&&!existing.disabledAt)proposedCurrent+=allowance-(cycle?.allocations?.[existing.id]?.amountCents??existing.allowanceCents);
  else if(!existing&&type==='fixed')proposedCurrent+=allowance;
  else if(!existing&&type==='increment')proposedCurrent+=contribution;
  const currentSalary=state.salaryCents;if(proposedCurrent>currentSalary)return showToast(`本月已分配会达到 ${money(proposedCurrent)}，超过月到手工资 ${money(proposedCurrent-currentSalary)}。请减少本月额度或调整工资。`);
  const now=Date.now(),contributionChanged=Boolean(existing&&type==='increment'&&contribution!==existing.contributionCents);
  if(existing){
    const oldAllowance=existing.allowanceCents,oldContribution=existing.contributionCents;Object.assign(existing,proposed,{openingCents:existing.openingCents});
     if(type==='fixed'&&allowance!==oldAllowance){if(!existing.disabledAt){addLedger(existing,'adjust',allowance-oldAllowance,`额度调整：${money(oldAllowance)} → ${money(allowance)}`,now);if(cycle)cycle.allocations[existing.id]={type,amountCents:allowance}}}
     if(type==='increment'&&contribution!==oldContribution){if(cycle&&!existing.disabledAt)cycle.allocations[existing.id]=cycle.allocations[existing.id]||{type,amountCents:oldContribution}}
  }else{
     state.funds.push(proposed);if(cycle){snapshotAllocation(cycle,proposed);if(type==='fixed')addLedger(proposed,'fixed-base',allowance,'加入钱包分类时设置额度',now,{cycleId:cycle.id});else if(type==='increment'){if(opening>0)addLedger(proposed,'opening',opening,'已有储蓄入账',now,{cycleId:cycle.id});if(contribution>0)addLedger(proposed,'increment',contribution,'加入本期的每月自动存入',now,{cycleId:cycle.id})}else if(opening>0)addLedger(proposed,'opening',opening,'储值卡初始余额',now,{cycleId:cycle.id})}
  }
  persist();closeModal('fundModal');showToast(existing?(contributionChanged?'钱包已更新；新的每月自动存入金额从下个发薪周期生效':'钱包已更新'):'钱包已添加');
}
function fundDeletionLinks(id){
  const ruleIds=new Set(state.rules.filter(r=>r.fundId===id).map(r=>r.id)),planIds=new Set(state.legacySubscriptions.filter(s=>s.fundId===id).map(s=>s.id));
  const rules=state.rules.filter(r=>r.fundId===id),plans=state.legacySubscriptions.filter(s=>s.fundId===id),occurrences=state.occurrences.filter(o=>(o.status==='pending'||o.status==='exception')&&(o.fundId===id||ruleIds.has(o.ruleId))),dues=state.legacyDues.filter(d=>(d.legacyStatus==='pending'||d.legacyStatus==='unbound')&&(d.fundId===id||planIds.has(d.subscriptionId)));
  return{ruleIds,planIds,rules,plans,occurrences,dues};
}
function updateDeleteFundFields(){
  const hidden=$('#deleteFundMode').value!=='move';$('#deleteFundTargetField').hidden=hidden;$('#deleteFundTarget').disabled=hidden;
}
function deleteFund(id){
  const fund=getFund(id);if(!fund)return;const linked=fundDeletionLinks(id);$('#deleteFundId').value=id;$('#deleteFundName').textContent=fund.name;$('#deleteFundRules').textContent=`关联未来计划：计划消费 ${linked.rules.length} 条，旧计划 ${linked.plans.length} 条。`;
  $('#deleteFundPending').textContent=`关联待确认账单：新计划 ${linked.occurrences.length} 笔，旧账单 ${linked.dues.length} 笔。`;
  const targets=state.funds.filter(f=>f.id!==id&&!f.disabledAt),balance=fundBalanceAt(fund,Date.now()),canDelete=balance===0;$('#deleteFundBalance').textContent=`当前余额 ${money(balance)}。${canDelete?'余额为 ¥0.00，可以删除。':'需先处理余额，或停用钱包保留。'}本期已分配额度不会因删除或停用而释放。`;
  $('#deleteFundTarget').innerHTML=targets.map(f=>`<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)}</option>`).join('');$('#deleteFundMode').value=targets.length?'move':'pause';$('#deleteFundMode').disabled=!targets.length;$('#deleteFundForm button[type="submit"]').disabled=!canDelete;$('#disableFundFromDelete').hidden=Boolean(fund.disabledAt);$('#disableFundFromDelete').textContent=fund.disabledAt?'钱包已停用':'停用并保留余额';$('#disableFundFromDelete').disabled=Boolean(fund.disabledAt);$('#deleteFundPlanFields').hidden=false;updateDeleteFundFields();openModal('deleteFundModal');
}
function commitFundDeletion(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');const id=$('#deleteFundId').value,fund=getFund(id),mode=$('#deleteFundMode').value,target=mode==='move'?getFund($('#deleteFundTarget').value):null;if(!fund)return showToast('这个钱包已删除');if(fundBalanceAt(fund,Date.now())!==0)return showToast(`钱包余额为 ${money(fundBalanceAt(fund,Date.now()))}，不能删除。请先处理余额或停用。`);if(!['move','pause'].includes(mode)||mode==='move'&&(!target||target.disabledAt))return showToast('请选择启用中的钱包处理关联计划和账单');
  const linked=fundDeletionLinks(id),now=Date.now();
  if(mode==='move'){
    for(const rule of linked.rules){rule.fundId=target.id;rule.fundName=target.name}
    for(const occurrence of linked.occurrences){occurrence.fundId=target.id;occurrence.fundName=target.name}
    for(const plan of linked.plans){plan.fundId=target.id;plan.boundAt=plan.boundAt||now}
    for(const due of linked.dues){due.fundId=target.id;due.legacyStatus='pending'}
  }else{
    for(const rule of linked.rules){rule.active=false;rule.stoppedAt=now}
    for(const occurrence of linked.occurrences)occurrence.fundId=null;
    for(const plan of linked.plans){plan.active=false;plan.fundId=null;plan.boundAt=null}
    for(const due of linked.dues){due.fundId=null;due.legacyStatus='unbound'}
  }
  state.funds=state.funds.filter(f=>f.id!==id);persist();closeModal('deleteFundModal');showToast(mode==='move'?'钱包已删除；计划和待确认账单已转交，历史流水保留':'钱包已删除；未来计划已暂停，待确认账单仍可稍后处理');
}
function openRule(rule=null){const fund=getFund(detailFundId);if(!fund)return showToast('请先从钱包明细进入');if(fund.disabledAt)return showToast('钱包已停用，恢复后才能添加或编辑计划');if(rule?.frequency==='once'&&state.occurrences.some(o=>o.ruleId===rule.id))return showToast('这笔一次性计划已生成待确认账单，不能再改期；请新建一条计划');$('#ruleForm').reset();$('#ruleId').value=rule?.id||'';$('#ruleModalTitle').textContent=rule?'编辑计划消费':'添加计划消费';$('#ruleName').value=rule?.name||'';$('#ruleFrequency').value=rule?.frequency||'month';$('#ruleAmount').value=rule?(rule.amountCents/100).toFixed(2):'';const due=rule?new Date(rule.nextDueAt):new Date();$('#ruleFirstDue').value=dateISO(due);$('#ruleHour').value=rule?due.getHours():9;openModal('ruleModal')}
function persistRule(rule){state.rules.push(rule);reconcileScheduledCycles();reconcileDueRules();persist();closeModal('ruleModal');renderWalletDetail();showToast('计划消费已保存')}
function saveRule(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');const fund=getFund(detailFundId),id=$('#ruleId').value,name=$('#ruleName').value.trim(),frequency=$('#ruleFrequency').value,amount=centsInput('#ruleAmount'),date=$('#ruleFirstDue').value,hour=Number($('#ruleHour').value);
   if(!fund||!name||amount==null||amount<=0||!['once','month','quarter','year'].includes(frequency)||!validDateString(date)||!Number.isInteger(hour)||hour<0||hour>23)return showToast('请检查计划名称、频率、金额和到期时间');
  const selectedDueAt=new Date(`${date}T${String(hour).padStart(2,'0')}:00:00`).getTime(),todayStart=new Date();todayStart.setHours(0,0,0,0);if(selectedDueAt<todayStart.getTime())return showToast('首次到期日不能早于今天');const firstDueAt=selectedDueAt<Date.now()?Date.now():selectedDueAt;
   const existing=state.rules.find(r=>r.id===id);if(existing?.frequency==='once'&&state.occurrences.some(o=>o.ruleId===existing.id))return showToast('这笔一次性计划已生成待确认账单，不能再改期；请新建一条计划');const rule={id:id||newId(),fundId:fund.id,fundName:fund.name,name,amountCents:amount,frequency,firstDueAt,nextDueAt:firstDueAt,anchorDay:Number(date.slice(8,10)),anchorMonth:Number(date.slice(5,7))-1,anchorHour:hour,active:true,createdAt:existing?.createdAt||Date.now(),legacySourceId:existing?.legacySourceId||null};
  const commit=()=>{if(existing)Object.assign(existing,rule);else state.rules.push(rule);reconcileScheduledCycles();reconcileDueRules();persist();closeModal('ruleModal');if($('#detailModal').classList.contains('open'))renderWalletDetail();showToast(existing?'计划已更新，之前的流水保持不变':'计划消费已添加')};
  if(selectedDueAt<Date.now())askConfirm('确认立即安排一次？',`${name} 设置的到期时间已过。确认后会立即生成一笔待确认账单，确认记账前不会扣除钱包余额。`,commit,'确认保存');else commit();
}
function rebindRuleToWallet(id,fundId){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const rule=state.rules.find(r=>r.id===id),fund=getFund(fundId);if(!rule||!fund)return;if(fund.disabledAt)return showToast('目标钱包已停用，请先恢复钱包后再选择付款钱包');
  const oneShotHandled=rule.frequency==='once'&&state.occurrences.some(o=>o.ruleId===rule.id);
  askConfirm('把计划消费转交给这个钱包？',oneShotHandled?`“${rule.name}”已有待确认账单会改由“${fund.name}”付款，不会再次生成一次性账单。`:`“${rule.name}”会从下一次未来到期开始由“${fund.name}”付款；错过的日期不会自动补扣。`,()=>{
    rule.fundId=fund.id;rule.fundName=fund.name;
    if(rule.frequency==='once'){rule.active=!oneShotHandled;rule.stoppedAt=oneShotHandled?rule.stoppedAt:null;if(!oneShotHandled)rule.nextDueAt=Number.isFinite(rule.nextDueAt)?Math.max(Date.now(),rule.nextDueAt):Date.now()}
    else{rule.active=true;rule.stoppedAt=null;let guard=0;while(rule.nextDueAt<=Date.now()&&guard++<1200)rule.nextDueAt=nextRuleDueAt(rule,rule.nextDueAt)}
     for(const occurrence of state.occurrences)if(occurrence.ruleId===rule.id&&(occurrence.status==='pending'||occurrence.status==='exception')){occurrence.fundId=fund.id;occurrence.fundName=fund.name}
    const plan=state.legacySubscriptions.find(s=>s.id===rule.legacySourceId);if(plan){plan.fundId=fund.id;plan.boundAt=Date.now();for(const due of state.legacyDues)if(due.subscriptionId===plan.id&&due.legacyStatus==='unbound'){due.fundId=fund.id;due.legacyStatus='pending'}}
    reconcileScheduledCycles();if(!oneShotHandled)reconcileDueRules();persist();renderWalletDetail();showToast(oneShotHandled?'已更换待确认账单的付款钱包':'已更换计划的付款钱包；错过的日期不会自动补扣');
  },'使用这个钱包');
}
function stopRule(id){const rule=state.rules.find(r=>r.id===id);if(!rule)return;askConfirm('停用这条计划消费？',`“${rule.name}”之后不再生成到期账单，已有待确认账单会保留。`,()=>{rule.active=false;rule.stoppedAt=Date.now();persist();renderWalletDetail();showToast('计划消费已停用')},'停用')}
function bindLegacyPlan(id,fundId){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const plan=state.legacySubscriptions.find(s=>s.id===id),fund=getFund(fundId);if(!plan||!fund)return;if(fund.disabledAt)return showToast('目标钱包已停用，请先恢复钱包后再选择付款钱包');
  const first=new Date(`${plan.nextDue}T09:00:00`),dummy={frequency:plan.frequency==='month'?'month':'year',anchorDay:plan.dueDay||Number(plan.nextDue.slice(8,10)),anchorMonth:plan.dueMonth??Number(plan.nextDue.slice(5,7))-1,anchorHour:9};while(first.getTime()<=Date.now())first.setTime(nextRuleDueAt(dummy,first.getTime()));
  const rule={id:newId(),fundId:fund.id,fundName:fund.name,name:plan.name,amountCents:plan.amountCents,frequency:dummy.frequency,firstDueAt:first.getTime(),nextDueAt:first.getTime(),anchorDay:dummy.anchorDay,anchorMonth:dummy.anchorMonth,anchorHour:9,active:Boolean(plan.active),createdAt:Date.now(),legacySourceId:plan.id};state.rules.push(rule);plan.fundId=fund.id;plan.boundAt=Date.now();for(const due of state.legacyDues)if(due.subscriptionId===plan.id&&due.legacyStatus==='unbound'){due.fundId=fund.id;due.legacyStatus='pending'}persist();renderWalletDetail();showToast('已选择付款钱包；历史待付款仍需逐笔确认')
}
function bindLegacyDue(id,fundId){const due=state.legacyDues.find(d=>d.id===id),fund=getFund(fundId);if(!due||!fund)return;if(fund.disabledAt)return showToast('目标钱包已停用，请先恢复钱包后再选择付款钱包');due.fundId=fund.id;due.legacyStatus='pending';persist();renderWalletDetail();showToast('已选择付款钱包；请确认实际付款后再记账')}
function openPending(id,legacy=false){const row=legacy?state.legacyDues.find(d=>d.id===id&&['pending','unbound'].includes(d.legacyStatus)):state.occurrences.find(item=>item.id===id&&['pending','exception'].includes(item.status));if(!row)return;$('#pendingRecordId').value=id;$('#pendingRecordType').value=legacy?'legacy':'occurrence';const rule=legacy?null:state.rules.find(r=>r.id===row.ruleId),name=legacy?row.subscriptionName:(rule?.name||row.fundName||'计划消费'),defaultDate=dateISO(new Date()),select=$('#pendingFund'),funds=state.funds.filter(f=>!f.disabledAt),preferred=funds.some(f=>f.id===(row.fundId||detailFundId))?(row.fundId||detailFundId):funds[0]?.id;$('#pendingTitle').textContent=`确认 ${name}`;select.innerHTML=funds.length?funds.map(f=>`<option value="${escapeHTML(f.id)}" ${f.id===preferred?'selected':''}>${escapeHTML(f.name)}</option>`).join(''):'<option value="">请先启用或添加钱包</option>';select.disabled=!funds.length;$('#pendingForm button[type="submit"]').disabled=!funds.length;$('#pendingAmount').value=(row.amountCents/100).toFixed(2);$('#pendingDate').value=defaultDate;openModal('pendingModal')}
function resolvePending(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const id=$('#pendingRecordId').value,type=$('#pendingRecordType').value,fund=getFund($('#pendingFund').value),amount=centsInput('#pendingAmount'),date=$('#pendingDate').value;if(!fund||fund.disabledAt||amount==null||amount<=0||!validDateString(date)||date>dateISO(new Date()))return showToast('请检查启用中的钱包、实际金额和付款日期');
  const occurrence=type==='occurrence'?state.occurrences.find(o=>o.id===id&&['pending','exception'].includes(o.status)):null,due=type==='legacy'?state.legacyDues.find(d=>d.id===id&&['pending','unbound'].includes(d.legacyStatus)):null;if(!occurrence&&!due)return showToast('这笔待确认账单已处理');
  const timestamp=date===dateISO(new Date())?Date.now():dateAtNoon(date).getTime(),name=due?due.subscriptionName:(state.rules.find(r=>r.id===occurrence.ruleId)?.name||occurrence.fundName||'计划消费'),row=addLedger(fund,'expense',amount,`计划消费：${name}`,timestamp,{occurrenceId:occurrence?.id||null,scheduleRuleId:occurrence?.ruleId||null,scheduledExpense:true,legacyDueId:due?.id||null,paymentId:due?.id||null,subscriptionName:name});
  if(occurrence){occurrence.status='confirmed';occurrence.confirmedAt=Date.now();occurrence.entryId=row.id;occurrence.actualFundId=fund.id;occurrence.fundId=fund.id;occurrence.fundName=fund.name;occurrence.amountCents=amount}
  if(due){due.legacyStatus='posted';due.fundId=fund.id;due.entryId=row.id;due.actualAmountCents=amount;due.actualDate=date;const payment=state.payments.find(p=>p.id===due.id);if(payment){payment.status='paid';payment.paidAt=Date.now();payment.actualAmountCents=amount;payment.actualDate=date;payment.fundId=fund.id;payment.fundName=fund.name;payment.expenseId=row.id}}
  reconcileClosedCycleSurpluses();persist();closeModal('pendingModal');showToast('已确认并记入钱包支出');
}
function cancelPending(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const id=$('#pendingRecordId').value,type=$('#pendingRecordType').value;askConfirm('取消这笔待确认账单？','取消后不会生成支出，也不会影响钱包余额。',()=>{if(type==='legacy'){const due=state.legacyDues.find(d=>d.id===id);if(due){due.legacyStatus='cancelled';const payment=state.payments.find(p=>p.id===id);if(payment)payment.status='cancelled'}}else{const o=state.occurrences.find(item=>item.id===id);if(o){o.status='cancelled';o.cancelledAt=Date.now()}}persist();closeModal('pendingModal');showToast('待确认账单已取消')},'取消账单')
}
function cancelOccurrence(id,legacy=false){if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const row=legacy?state.legacyDues.find(d=>d.id===id):state.occurrences.find(o=>o.id===id);if(!row)return;askConfirm('取消这笔待确认账单？','取消后不会生成支出，也不会影响余额。',()=>{if(legacy){row.legacyStatus='cancelled';const payment=state.payments.find(p=>p.id===row.id);if(payment)payment.status='cancelled'}else{row.status='cancelled';row.cancelledAt=Date.now()}persist();showToast('待确认账单已取消')},'取消账单')}
function renderWalletSchedules(fund){
  const rules=state.rules.filter(r=>r.fundId===fund.id);$('#ruleList').innerHTML=rules.length?rules.map(r=>{const pending=state.occurrences.filter(o=>o.ruleId===r.id&&(o.status==='pending'||o.status==='exception'));return `<article class="subscription-card"><div class="subscription-main"><strong>${escapeHTML(r.name)}</strong><span>${r.frequency==='once'?'一次性':r.frequency==='month'?'每月':r.frequency==='quarter'?'每季度':'每年'} ${money(r.amountCents)} · ${r.active?`下次到期 ${scheduleLabel(r.nextDueAt)}`:'已停用'}${pending.length?` · 待确认 ${pending.length} 笔，共 ${money(pending.reduce((s,o)=>s+o.amountCents,0))}`:''}</span></div><div class="subscription-actions">${r.frequency==='once'&&state.occurrences.some(o=>o.ruleId===r.id)?'':`<button type="button" data-edit-rule="${escapeHTML(r.id)}">编辑</button>`}${r.active?`<button type="button" class="danger-action" data-stop-rule="${escapeHTML(r.id)}">停用</button>`:''}</div></article>`}).join(''):'<div class="empty-state">当前钱包没有计划消费。</div>';
  const orphanRules=state.rules.filter(r=>!getFund(r.fundId)),plans=state.legacySubscriptions.filter(s=>!s.boundAt&&!state.rules.some(r=>r.legacySourceId===s.id));const dues=state.legacyDues.filter(d=>['unbound','pending'].includes(d.legacyStatus)&&(!d.fundId||d.fundId===fund.id));$('#legacyList').innerHTML=[...orphanRules.map(r=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(r.name)}</strong><span>原钱包已删除 · ${r.frequency==='once'?'一次性':r.frequency==='month'?'每月':r.frequency==='quarter'?'每季度':'每年'} ${money(r.amountCents)} · 已暂停；下次到期时间保留。</span></div><button type="button" class="primary-button compact" data-rebind-rule="${escapeHTML(r.id)}" data-wallet="${escapeHTML(fund.id)}">使用这个钱包付款</button></article>`),...plans.map(s=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(s.name)}</strong><span>旧计划 · ${s.frequency==='month'?'每月':'每年'} ${money(s.amountCents)} · 下次计划 ${shortDate(s.nextDue)}。</span></div><button type="button" class="primary-button compact" data-bind-legacy-plan="${escapeHTML(s.id)}" data-wallet="${escapeHTML(fund.id)}">使用这个钱包付款</button></article>`),...dues.map(d=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(d.subscriptionName)}</strong><span>旧待确认账单 · ${shortDate(d.dueDate)} · ${money(d.amountCents)} · ${d.fundId?'已选择钱包':'待选择钱包'}</span></div><button type="button" class="primary-button compact" data-handle-pending="${escapeHTML(d.id)}" data-pending-type="legacy">确认账单</button><button type="button" class="secondary-button compact" data-cancel-legacy="${escapeHTML(d.id)}">取消</button></article>`)].join('')||'<div class="empty-state">没有旧计划或待确认账单。</div>';
  const pendingRows=state.occurrences.filter(o=>(o.status==='pending'||o.status==='exception')&&(!o.fundId||o.fundId===fund.id));$('#exceptionList').innerHTML=pendingRows.length?pendingRows.map(o=>`<article class="subscription-card pending-card"><div class="subscription-main"><strong>${escapeHTML(state.rules.find(r=>r.id===o.ruleId)?.name||o.fundName||'计划消费')}</strong><span>${scheduleLabel(o.dueAt)} · 尚未扣款 · ${money(o.amountCents)}</span></div><button type="button" class="primary-button compact" data-handle-pending="${escapeHTML(o.id)}">确认账单</button><button type="button" class="secondary-button compact" data-cancel-occurrence="${escapeHTML(o.id)}">取消</button></article>`).join(''):'<div class="empty-state">没有待确认账单。</div>';
}
function updateAccountSetupFields(){const medical=$('#accountType').value==='medical';$('#accountDefaultCompanyField').hidden=medical;$('#accountDefaultCompany').disabled=medical;$('#accountDefaultCompany').required=false;$('#accountDefaultPersonal').closest('label').querySelector('.field-label').textContent=medical?'每月医保账户入账':'每月个人公积金入账'}
function openAccountSetup(account=null){const type=account?.type||'provident',personal=type==='medical'?(account?.monthlyMedicalCents??0):(account?.monthlyPersonalCents??account?.defaultPersonalCents??0);$('#accountSetupForm').reset();$('#accountSetupId').value=account?.id||'';$('#accountSetupTitle').textContent=account?'管理账户':'添加公积金或医保';$('#accountType').value=type;$('#accountType').disabled=Boolean(account);$('#accountName').value=account?.name||(type==='medical'?'医保个人账户':'住房公积金');$('#accountOpening').value='0';$('#accountOpening').disabled=Boolean(account);$('#accountDefaultPersonal').value=(personal/100).toFixed(2);$('#accountDefaultCompany').value=((account?.monthlyCompanyCents??account?.defaultCompanyCents??0)/100).toFixed(2);updateAccountSetupFields();openModal('accountSetupModal')}
function saveAccountSetup(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const id=$('#accountSetupId').value,type=$('#accountType').value,name=$('#accountName').value.trim(),opening=centsInput('#accountOpening'),monthly=centsInput('#accountDefaultPersonal'),company=type==='medical'?0:centsInput('#accountDefaultCompany');if(!name||!['provident','medical'].includes(type)||opening==null||opening<0||monthly==null||monthly<0||company==null||company<0)return showToast('请检查账户名称和金额');
  let account=getAccount(id);if(account){account.name=name;account.defaultPersonalCents=monthly;account.defaultCompanyCents=company;account.monthlyPersonalCents=type==='provident'?monthly:0;account.monthlyCompanyCents=company;account.monthlyMedicalCents=type==='medical'?monthly:0;account.effectiveFromAt=nextScheduledAt()}else{account={id:newId(),type,name,openingCents:0,defaultPersonalCents:monthly,defaultCompanyCents:company,monthlyPersonalCents:type==='provident'?monthly:0,monthlyCompanyCents:company,monthlyMedicalCents:type==='medical'?monthly:0,effectiveFromAt:nextScheduledAt(),createdAt:Date.now()};state.accounts.push(account);if(opening>0)addAccountLedger(account,'opening',opening,'登记已有余额',Date.now())}persist();closeModal('accountSetupModal');showToast(id?'账户信息已更新；新金额从下个发薪日开始':'账户已添加；每月入账从下个发薪日开始')
}
function scheduledCreditForCurrentMonth(account){const key=String(state.lastScheduledAt||latestPaydayAt(new Date())),kind=account.type==='provident'?'provident-credit':'medical-credit';return state.accountEntries.find(row=>row.accountId===account.id&&row.kind===kind&&row.scheduledKey===key)||null}
function updateAccountCreditPreview(){const account=getAccount($('#accountEntryId').value),row=state.accountEntries.find(item=>item.id===$('#accountAutoCreditId').value);if(!row||!account)return;const entered=account.type==='provident'?(centsInput('#accountPersonalAmount')||0)+(centsInput('#accountCompanyAmount')||0):(centsInput('#accountMedicalAmount')||0);$('#accountCreditPreview').textContent=`本次自动登记 ${money(row.amountCents)}；${$('#accountCreditMode').value==='correct'?'修正为 '+money(entered)+'，保留原自动登记周期。':'作为额外到账新增 '+money(entered)+'。'}`}
function updateAccountEntryFields(){const account=getAccount($('#accountEntryId').value),action=$('#accountAction').value,credit=action==='credit',transferOption=$('#accountAction').querySelector('option[value="transfer"]');transferOption.hidden=account?.type!=='provident';if(account?.type==='medical'&&action==='transfer')$('#accountAction').value='expense';const actualAction=$('#accountAction').value,hasAutoCredit=Boolean(state.accountEntries.some(row=>row.id===$('#accountAutoCreditId').value));$('#accountProvidentCreditFields').hidden=!(credit&&account?.type==='provident');$('#accountMedicalCreditField').hidden=!(credit&&account?.type==='medical');$('#accountCreditModeField').hidden=!(credit&&hasAutoCredit);$('#accountUseFields').hidden=actualAction==='credit';$('#accountTargetField').hidden=actualAction!=='transfer';$('#accountEntryTitle').textContent=account?`${account.name} · ${actualAction==='credit'?'登记实际到账':actualAction==='transfer'?'提取到钱包':'账户消费'}`:'账户流水';if(credit&&hasAutoCredit)updateAccountCreditPreview()}
function openAccountEntry(id,action='credit'){const account=getAccount(id);if(!account)return;$('#accountEntryForm').reset();$('#accountEntryId').value=id;$('#accountAction').value=account.type==='medical'&&action==='transfer'?'expense':action;const automatic=action==='credit'?scheduledCreditForCurrentMonth(account):null;$('#accountAutoCreditId').value=automatic?.id||'';$('#accountCreditMode').value=automatic?'correct':'extra';$('#accountEntryDate').value=dateISO(new Date());$('#accountPersonalAmount').value=((automatic?.personalCents??account.defaultPersonalCents)/100).toFixed(2);$('#accountCompanyAmount').value=((automatic?.companyCents??account.defaultCompanyCents)/100).toFixed(2);$('#accountMedicalAmount').value=((automatic?.amountCents??(account.type==='medical'?account.defaultPersonalCents:0))/100).toFixed(2);$('#accountUseAmount').value='';$('#accountEntryNote').value='';$('#accountTargetFund').innerHTML=state.funds.filter(f=>!f.disabledAt).map(f=>`<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)}</option>`).join('');updateAccountEntryFields();openModal('accountEntryModal')}
function saveAccountEntry(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份');const account=getAccount($('#accountEntryId').value),action=$('#accountAction').value,date=$('#accountEntryDate').value,note=$('#accountEntryNote').value.trim();if(!account||!validDateString(date)||date>dateISO(new Date()))return showToast('请检查账户和实际日期');const timestamp=date===dateISO(new Date())?Date.now():dateAtNoon(date).getTime();
  if(action==='credit'){
    const automaticId=$('#accountAutoCreditId').value,mode=$('#accountCreditMode').value,automatic=automaticId?state.accountEntries.find(row=>row.id===automaticId&&row.accountId===account.id):null,correcting=Boolean(automaticId&&mode==='correct');let amount,extra={};if(account.type==='provident'){const personal=centsInput('#accountPersonalAmount'),company=centsInput('#accountCompanyAmount');if(personal==null||company==null||personal<0||company<0||(!correcting&&personal+company<=0))return showToast('请填写有效的个人和单位到账金额');amount=personal+company;extra={personalCents:personal,companyCents:company}}else{amount=centsInput('#accountMedicalAmount');if(amount==null||amount<0||(!correcting&&amount===0))return showToast('请填写有效的医保划入金额')}
    if(automaticId&&mode==='correct'){if(!automatic||!automatic.scheduledKey)return showToast('找不到本月自动登记记录，请刷新页面后重试');const now=Date.now(),without=account.openingCents+state.accountEntries.filter(row=>row.accountId===account.id&&row.id!==automatic.id&&row.timestamp<=now).reduce((balance,row)=>balance+(row.kind==='provident-credit'||row.kind==='medical-credit'||row.kind==='opening'?row.amountCents:-row.amountCents),0);if(without+amount<0)return showToast('修正后账户余额会变成负数；请先核对已记录的账户支出或提取');Object.assign(automatic,{...extra,amountCents:amount,date,timestamp,note:note||(amount===0?'本月实际未到账（修正自动登记）':`${account.type==='provident'?'公积金':'医保'}实际到账（修正自动登记）`),correctedAt:Date.now()})}
    else addAccountLedger(account,account.type==='provident'?'provident-credit':'medical-credit',amount,note||`${account.type==='provident'?'公积金':'医保'}额外到账`,timestamp,extra);
  }else{
    const amount=centsInput('#accountUseAmount'),kind=action==='transfer'?'transfer-out':'expense',fund=getFund($('#accountTargetFund').value);if(amount==null||amount<=0)return showToast('请输入有效金额');if(action==='transfer'&&account.type!=='provident')return showToast('医保账户不能提取到钱包');if(action==='transfer'&&(!fund||fund.disabledAt))return showToast('请选择启用中的转入钱包');if(accountBalanceAt(account,timestamp)<amount)return showToast('账户余额不足');const transferId=action==='transfer'?newId():null;addAccountLedger(account,kind,amount,note||(action==='transfer'?'提取到钱包':'账户消费'),timestamp,{transferId,targetFundId:fund?.id||null,targetFundName:fund?.name||null});if(action==='transfer')addLedger(fund,'transfer-in',amount,`账户转入：${account.name}`,timestamp,{transferId,accountId:account.id,accountName:account.name});
  }
  persist();closeModal('accountEntryModal');showToast('账户流水已登记')
}
function refreshAccountDetail(){const id=$('#accountDetailModal').dataset.accountId,account=getAccount(id);if(!account)return;$('#accountDetailTitle').textContent=account.name;$('#accountDetailBalance').innerHTML=`<span>当前余额</span><strong>${money(accountBalanceAt(account))}</strong><small>${account.type==='provident'?'公积金账户':'医保个人账户'}</small>`;const rows=state.accountEntries.filter(e=>e.accountId===id).sort((a,b)=>b.timestamp-a.timestamp);$('#accountDetailRecords').innerHTML=rows.map(e=>{const credit=e.kind==='provident-credit'||e.kind==='medical-credit',origin=e.scheduledKey?(e.correctedAt?'自动登记 · 已修正':'自动登记'):'手动登记';return `<div class="record-row"><span class="record-icon paid-icon">${e.kind==='expense'?'−':e.kind==='transfer-out'?'↗':'+'}</span><div class="record-main"><div class="record-title">${escapeHTML(e.note||accountDetailKind(e))}</div><div class="record-sub">${shortDate(e.date)} ${new Date(e.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}${credit?` · ${origin}`:''}${e.kind==='provident-credit'?` · 个人 ${money(e.personalCents)} + 单位 ${money(e.companyCents)}`:''}</div></div><strong class="record-amount ${e.kind==='expense'||e.kind==='transfer-out'?'expense-amount':'positive-amount'}">${e.kind==='expense'||e.kind==='transfer-out'?'−':'+'}${money(e.amountCents)}</strong></div>`}).join('')||'<div class="empty-state">还没有账户流水。</div>'}
function openAccountDetail(id){const account=getAccount(id);if(!account)return;$('#accountDetailModal').dataset.accountId=id;refreshAccountDetail();openModal('accountDetailModal')}
function openWalletDetail(id){const fund=getFund(id);if(!fund)return;detailFundId=id;$('#detailTitle').textContent=fund.name;$('#detailPeriod').value='month';$('#detailCycle').hidden=true;$('#addRuleBtn').hidden=Boolean(fund.disabledAt);renderWalletDetail();openModal('detailModal')}
function renderWalletDetail(){
  const fund=getFund(detailFundId);if(!fund)return;const mode=$('#detailPeriod').value,now=Date.now();let startAt,endAt=now+1,cycle=null;
  renderWalletSchedules(fund);
  $('#detailCycle').hidden=mode!=='history';
  if(mode==='month'){const r=currentCycleRange();startAt=r.startAt;endAt=r.endAt===Infinity?now+1:r.endAt}
  else if(mode==='history'){
    const cycles=reportCycles().filter(c=>c.startAt<(openCycle()?.startAt||Infinity)).sort((a,b)=>b.startAt-a.startAt),select=$('#detailCycle'),previous=select.value;select.innerHTML=cycles.map(c=>`<option value="${c.id}">${escapeHTML(cycleOptionText(c))}</option>`).join('');if(!cycles.length){$('#detailBalance').textContent='暂无历史发薪周期';$('#detailRecords').innerHTML='<div class="empty-state">还没有历史周期。</div>';return}select.value=cycles.some(c=>c.id===previous)?previous:cycles[0].id;cycle=cycles.find(c=>c.id===select.value);const r=rangeForCycle(cycle);startAt=r.startAt;endAt=r.endAt;
  }else{const earliest=entriesForFund(fund.id).reduce((m,e)=>Math.min(m,e.timestamp),fund.createdAt);startAt=earliest}
  const rows=entriesForFund(fund.id).filter(e=>e.timestamp>=startAt&&e.timestamp<endAt);$('#detailBalance').innerHTML=`<span>${mode==='history'?'期末余额':'当前余额'}</span><strong>${money(fundBalanceAt(fund,endAt-1))}</strong><small>${mode==='month'?'本月':mode==='all'?'全部记录':'历史周期'} · ${money(sumExpenses(rows,fund.id))} 支出</small>`;$('#detailRecords').innerHTML=renderEntries(rows,true);
}

function saveSalarySettings(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  const salary=centsInput('#salaryInput'),day=Number($('#paydayInput').value),hour=Number($('#paydayHourInput').value);
  if(salary==null||salary<0)return showToast('请输入有效的月到手工资');
  if(!Number.isInteger(day)||day<1||day>31)return showToast('发薪日须为 1 到 31 日');if(!Number.isInteger(hour)||hour<0||hour>23)return showToast('刷新时间须为 0 到 23 时');
  const planned=allocationTotal(),current=currentCycleAllocation();if(planned>salary)return showToast(`下期计划分配 ${money(planned)} 超过月到手工资 ${money(salary)}，请减少钱包额度。`);if(current>salary)return showToast(`本期已分配 ${money(current)} 超过月到手工资 ${money(salary)}，请调整钱包额度。`);
  const scheduleChanged=day!==state.payday||hour!==state.paydayHour;state.salaryCents=salary;state.payday=day;state.paydayHour=hour;if(scheduleChanged)state.scheduleChangedAt=Date.now();const cycle=openCycle();if(cycle){cycle.salaryCents=salary;cycle.salarySnapshot={payrollKey:payrollKeyFromStart(cycle.startAt),netCents:salary}}
  $('#salaryForm').dataset.loaded='false';$('#salaryForm').dataset.dirty='false';persist();showToast(scheduleChanged?'工资和发薪时间已更新':'月到手工资已更新');
}
function restoreSettings(message){$('#salaryForm').dataset.loaded='false';renderSettings(true);showToast(message)}
function openRefresh(){const next=nextScheduledAt();$('#refreshNextText').textContent=`下次自动刷新仍为 ${scheduleLabel(next)}，手动操作不会修改发薪日设置。`;$('#refreshPreview').textContent='选择一种操作，先查看各类余额变化，再决定是否确认。';openModal('refreshModal')}
function startNewCycle(origin='manual'){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  const old=openCycle(),now=Math.max(Date.now(),(old?.startAt||0)+1),cycle=makeCycle(now,origin);if(old){sweepFixedSurplus(old,now,cycle.id);old.endAt=now}state.cycles.push(cycle);addCycleStartEvents(cycle,now,false);persist();closeModal('refreshModal');showToast('已开始新周期；每月预算剩余金额已转入累计结余，下次仍按发薪时间刷新。');
}
function resetCurrentCycle(){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  const now=Date.now(),cycle=openCycle();if(!cycle)return;const negative=state.funds.find(f=>!f.disabledAt&&f.type==='fixed'&&fundBalanceAt(f,now)<0);if(negative)return showToast(`${negative.name} 仍有待处理负余额。请先从其他每月预算钱包转入补齐，或手动开始新周期登记待处理超支。`);for(const fund of state.funds)if(fund.type==='fixed'&&!fund.disabledAt)addLedger(fund,'reset',fund.allowanceCents,'本周期手动重置额度',now,{cycleId:cycle.id});persist();closeModal('refreshModal');showToast('每月预算钱包已重置，账单保留。');
}
function describeRefresh(kind){
  const now=Date.now(),fixed=state.funds.filter(f=>f.type==='fixed'&&!f.disabledAt),increments=state.funds.filter(f=>f.type==='increment'&&!f.disabledAt),stored=state.funds.filter(f=>f.type==='stored'&&!f.disabledAt),disabled=state.funds.filter(f=>f.disabledAt),balance=f=>fundBalanceAt(f,now),overdue=outstandingOverdrafts().reduce((sum,row)=>sum+row.outstandingCents,0),cycle=openCycle();
  if(kind==='new'){
    const allocations=cycle?.allocations||{},snapshotIds=Object.entries(allocations).filter(([,a])=>a?.type==='fixed').map(([id])=>id),fixedIds=[...new Set([...snapshotIds,...state.funds.filter(f=>f.type==='fixed').map(f=>f.id)])],excluded=new Set(cycle?.surplusExcludedFundIds||[]);
    const fixedRows=fixedIds.map(id=>{const fund=getFund(id),allocation=allocations[id],hasSnapshot=allocation?.type==='fixed',current=fund?balance(fund):0,skipSweep=!hasSnapshot||excluded.has(id)||Boolean(fund?.disabledAt);let next=null,label='';
      if(!fund){label=`${fundNameFor(id)}（历史钱包已删除，本期已分配额度保留；下期不刷新）`;}
      else if(fund.disabledAt){next=Math.max(0,current);label=`${fund.name}（停用） ${money(current)} → ${money(next)}${current<0?'（归零并登记待处理超支）':'（余额保留，不刷新）'}`;}
      else if(!hasSnapshot){next=fund.allowanceCents+(fund.restoredAt?Math.max(0,current):0);label=`${fund.name} ${money(current)} → ${money(next)}（本月尚未分配预算；下期恢复计划${fund.restoredAt?'并保留余额':''}）`;}
      else if(skipSweep){next=fund.allowanceCents+(fund.restoredAt?Math.max(0,current):0);label=`${fund.name} ${money(current)} → ${money(next)}（不归集，保留余额后下期刷新）`;}
      else{next=fund.allowanceCents;label=`${fund.name} ${money(current)} → ${money(next)}（结余转累计结余）`;}
      return{id,fund,allocation,hasSnapshot,current,skipSweep,next,label};
    });
    const settled=fixedRows.reduce((sum,row)=>sum+(row.hasSnapshot&&!row.skipSweep?Math.max(0,row.current):0),0),newDebt=fixedRows.reduce((sum,row)=>sum+(row.hasSnapshot?Math.max(0,-row.current):0),0),incrementChanges=increments.map(f=>`${f.name} ${money(balance(f))} → ${money(balance(f)+f.contributionCents)}（${f.contributionCents>0?`每月自动存入 +${money(f.contributionCents)}`:'每月自动存入为 ¥0.00'}）`),storedChanges=stored.map(f=>`${f.name} ${money(balance(f))} → ${money(balance(f))}`),disabledLong=disabled.filter(f=>f.type!=='fixed').map(f=>`${f.name}（停用） ${money(balance(f))} → ${money(balance(f))}（保留，不刷新）`),currentSurplus=savingsBalanceAt(now),accountText=state.accounts.length?`公积金/医保 ${money(state.accounts.reduce((sum,a)=>sum+accountBalanceAt(a,now),0))} → 不变`:'';
    return [`开始新周期 ${scheduleLabel(now)}`,`钱包余额：${[...fixedRows.map(row=>row.label),...incrementChanges,...storedChanges,...disabledLong].join('；')||'没有需变更的钱包'}`,`累计结余 ${money(currentSurplus)} → ${money(currentSurplus+settled)}（本月转入结余 ${money(settled)}）`,accountText,`历史待处理超支 ${money(overdue)} 保留；本期预计新增缺口 ${money(newDebt)}，刷新后待处理合计 ${money(overdue+newDebt)}。`,`待确认账单保留，仍需逐笔确认。`,`下次自动刷新仍为 ${scheduleLabel(nextScheduledAt())}。`].filter(Boolean).join('\n');
  }
  const negative=fixed.filter(f=>balance(f)<0),changes=[...fixed.map(f=>`${f.name} ${money(balance(f))} → ${money(f.allowanceCents)}`),...increments.map(f=>`${f.name} ${money(balance(f))} → ${money(balance(f))}（长期储蓄保留；每月自动存入 ${money(f.contributionCents)}）`),...stored.map(f=>`${f.name} ${money(balance(f))} → ${money(balance(f))}`),...disabled.map(f=>`${f.name}（停用） ${money(balance(f))} → ${money(balance(f))}`)];return [`重设本期额度（不改变周期日期）`,`钱包余额：${changes.join('；')||'没有参与刷新的钱包'}`,`累计结余 ${money(savingsBalanceAt(now))} → 不变；公积金、医保 ${money(state.accounts.reduce((sum,a)=>sum+accountBalanceAt(a,now),0))} → 不变。`,`已有待处理超支 ${money(overdue)} 保留。`,negative.length?`当前有负余额：${negative.map(f=>f.name).join('、')}。本操作会被阻止，请先补齐或开始新周期登记缺口。`:'账单记录保留；停用钱包和会员储值余额不变。'].join('\n');
}

function deleteEntry(id){
  if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');
  const accountRow=state.accountEntries.find(e=>`account-${e.id}`===id&&e.kind==='expense'),savingsRow=state.savingsEntries.find(e=>`savings-${e.id}`===id&&e.kind==='expense'),row=state.entries.find(e=>e.id===id&&e.kind==='expense');if(!row&&!accountRow&&!savingsRow)return;
  const item=row||savingsRow&&{...savingsRow,fundName:'累计结余'}||{...accountRow,fundName:`${accountRow.accountName||getAccount(accountRow.accountId)?.name||'账户'}（账户）`};
  askConfirm('删除这笔支出？',`${item.fundName} · ${shortDate(item.date)} · ${money(item.amountCents)}。删除后余额会按剩余流水重新计算。`,()=>{
    if(accountRow)state.accountEntries=state.accountEntries.filter(e=>e.id!==accountRow.id);else if(savingsRow)state.savingsEntries=state.savingsEntries.filter(e=>e.id!==savingsRow.id);else state.entries=state.entries.filter(e=>e.id!==id);
    if(row?.occurrenceId){const occurrence=state.occurrences.find(o=>o.id===row.occurrenceId);if(occurrence){occurrence.status='cancelled';occurrence.cancelledAt=Date.now();occurrence.entryId=null}}
    if(row?.legacyDueId){const due=state.legacyDues.find(d=>d.id===row.legacyDueId);if(due){due.legacyStatus='pending';due.entryId=null}}
    if(row?.paymentId){const payment=state.payments.find(p=>p.id===row.paymentId);if(payment){const restoreDate=payment.actualDate||payment.dueDate,restoreAmount=payment.actualAmountCents||payment.amountCents;payment.status='pending';payment.paidAt=null;payment.actualAmountCents=null;payment.actualDate=null;payment.fundId=null;payment.fundName=null;payment.expenseId=null;if(!state.legacyDues.some(d=>d.id===payment.id))state.legacyDues.push({id:payment.id,subscriptionId:payment.subscriptionId,subscriptionName:payment.subscriptionName,dueDate:restoreDate,amountCents:restoreAmount,legacyStatus:'unbound',fundId:null,entryId:null})}}
    reconcileClosedCycleSurpluses();persist();showToast(accountRow?'账户支出已删除':savingsRow?'累计结余支出已删除':row?.paymentId?'支出已删除，相关旧付款已恢复待处理':'支出已删除，钱包余额已更新');
  },'删除');
}

function exportData(){
  const exportedAt=Date.now(),filename=`花在哪备份-${dateISO(new Date())}.json`;
  if(nativeStorage){
    if(typeof nativeBridge.exportLedger!=='function')return showToast('此 Android 版本不支持导出备份');
    pendingNativeExportAt=exportedAt;try{nativeBridge.exportLedger(JSON.stringify({...state,lastExportAt:exportedAt}),filename);showToast('正在准备备份…')}catch(error){pendingNativeExportAt=null;showToast(`备份导出失败：${error.message||'请重试'}`)}return;
  }
  state.lastExportAt=exportedAt;persist(false);const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);renderSettings();showToast('备份已导出');
}
function applyImportText(text){
  try{
    const imported=decodeLedger(text);
    askConfirm('导入备份并替换当前数据？',`备份包含 ${imported.funds.length} 个钱包、${imported.entries.length} 条钱包账目、${imported.rules.length} 条计划消费和 ${imported.accounts.length} 个账户。导入后会替换当前账本。`,()=>{
      const wasOnboarding=onboardingNeeded,wasBlocked=storageBlocked;state=imported;storageBlocked=false;storageWritable=true;
      $('#salaryForm').dataset.loaded='false';$('#salaryForm').dataset.dirty='false';reconcileClosedCycleSurpluses();reconcileScheduledCycles();reconcileDueRules();const saved=persist(false);closeModal('confirmModal',true);
      if(saved){onboardingNeeded=false;clearSetupDraft();showOnboarding(false);render();showToast('备份已导入')}
      else{onboardingNeeded=wasOnboarding;storageBlocked=wasBlocked||storageBlocked;showOnboarding(wasOnboarding);render()}
    },'导入');
  }catch(error){showToast(`备份无效，现有数据未更改：${error.message||'请检查文件内容'}`)}
}
function importDataFile(file){if(!file)return;file.text().then(applyImportText).catch(error=>showToast(`备份读取失败：${error.message||'请重试'}`)).finally(()=>$('#importFile').value='')}
function requestImport(){
  if(nativeStorage){if(typeof nativeBridge.requestImport!=='function')return showToast('此 Android 版本不支持导入备份');try{nativeBridge.requestImport()}catch(error){showToast(`无法打开备份文件：${error.message||'请重试'}`)}return}
  $('#importFile').click();
}
window.onNativeExportResult=(success,message)=>{
  const timestamp=pendingNativeExportAt;pendingNativeExportAt=null;
  if(success===true&&timestamp){state.lastExportAt=timestamp;const saved=persist(false);renderSettings();showToast(saved?'备份已导出':'备份已导出，但备份时间未能保存到账本')}
  else if(message)showToast(`备份未导出：${message}`);
};
window.onNativeImportResult=(json,error)=>{if(error){showToast(`备份导入已取消或失败：${error}`);return}if(!json){showToast('没有选择备份文件');return}applyImportText(json)};

function bindEvents(){
  bindTypeChoices();
  $$('.nav-item').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.page)));
  $('#setupFundType').addEventListener('change',()=>{toggleSetupFundFields();saveSetupDraft()});
  $('#onboarding').addEventListener('input',event=>{if(event.target.matches('input,select')){saveSetupDraft();showSetupMessage('')}});
  $('#setupStep1Next').addEventListener('click',()=>{try{readSetupSalary();setupDraft.includeWallet=true;showSetupStep(2)}catch(error){showSetupMessage(error.message||'请检查填写内容',true)}});
  $('#setupStep2Next').addEventListener('click',()=>advanceSetup(true));$('#setupStep2Later').addEventListener('click',()=>advanceSetup(false));
  $('#setupBackTo1').addEventListener('click',()=>showSetupStep(1));$('#setupBackTo2').addEventListener('click',()=>showSetupStep(2));$('#setupStart').addEventListener('click',startSetup);$('#onboardingImportBtn').addEventListener('click',requestImport);
  $('#addWalletBtn').addEventListener('click',()=>openFund());$('#addAccountBtn').addEventListener('click',()=>openAccountSetup());
  $('#fundType').addEventListener('change',toggleFundFields);
  $('#fundForm').addEventListener('submit',event=>{event.preventDefault();createFund()});
  $('#entryForm').addEventListener('submit',event=>{event.preventDefault();if(storageBlocked)return showToast('保存已暂停，请先导入有效备份以保护原数据');const amount=centsInput('#entryAmount'),kind=$('#entryForm').dataset.kind||'expense',note=$('#entryNote').value.trim(),timestamp=Date.now();if(amount==null||amount<=0)return showToast('请输入大于 0 的有效金额');if(kind==='surplus-expense'){const balance=savingsBalanceAt(timestamp);if(amount>balance)return showToast('支出金额不能超过累计结余可用余额');state.savingsEntries.push({id:newId(),kind:'expense',date:dateISO(new Date(timestamp)),timestamp,amountCents:amount,note:note||'累计结余支出'});}else{const fund=getFund($('#entryFund').value);if(!fund)return showToast('请选择有效的钱包');if(kind==='expense'&&fund.type==='increment'&&amount>fundBalanceAt(fund,timestamp))return showToast('支出金额不能超过长期储蓄可用余额');addLedger(fund,kind,amount,note||(kind==='topup'?'储值卡充值':''),timestamp)}persist();closeModal('entryModal');showToast(kind==='topup'?'充值已记录':'记下了这笔支出')});
  $('#salaryForm').addEventListener('submit',event=>{event.preventDefault();saveSalarySettings()});$('#salaryForm').addEventListener('input',()=>{$('#salaryForm').dataset.dirty='true'});
  $('#refreshNowBtn').addEventListener('click',openRefresh);
  $$('.refresh-option').forEach(button=>button.addEventListener('click',()=>{const kind=button.dataset.refreshKind, title=kind==='new'?'确认开始新周期？':'确认重置本周期？',preview=describeRefresh(kind);$('#refreshPreview').textContent=preview;askConfirm(title,preview,()=>kind==='new'?startNewCycle('manual'):resetCurrentCycle(),kind==='new'?'开始新周期':'重置额度')}));
  $('#reportTabs').addEventListener('click',event=>{const button=event.target.closest('[data-report]');if(!button)return;selectedReport=button.dataset.report;selectedDay='';if(selectedReport==='month')selectedCycleId=openCycle()?.id||'';if(selectedReport==='history'){const past=reportCycles().filter(c=>c.startAt<(openCycle()?.startAt||Infinity));selectedCycleId=past.at(-1)?.id||''}if(selectedReport==='year')selectedYear=new Date().getFullYear();renderReports()});
  $('#reportContextSelect').addEventListener('change',event=>{if(selectedReport==='year'){selectedYear=Number(event.target.value);selectedReport='year'}else selectedCycleId=event.target.value;selectedDay='';renderReports()});
  $('#reportFundFilter').addEventListener('change',renderReports);$('#clearDayFilter').addEventListener('click',()=>{selectedDay='';renderReports()});
  $('#timelineList').addEventListener('click',event=>{const day=event.target.closest('[data-day-filter]'),month=event.target.closest('[data-payroll-month]');if(day){selectedDay=selectedDay===day.dataset.dayFilter?'':day.dataset.dayFilter;renderReports()}else if(month){selectedMonthIndex=Number(month.dataset.payrollMonth);selectedReport='paymonth';selectedYear=selectedYear;selectedDay='';renderReports()}});
  $('#walletBreakdown').addEventListener('click',event=>{const button=event.target.closest('[data-breakdown-fund]');if(button){$('#reportFundFilter').value=button.dataset.breakdownFund;renderReports()}});
  $('#fundGrid').addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.walletId)openEntry(target.dataset.walletId);
    else if(target.dataset.topupWallet)openEntry(target.dataset.topupWallet,'topup');
    else if(target.dataset.walletDetail)openWalletDetail(target.dataset.walletDetail);
    else if(target.dataset.deleteFund)deleteFund(target.dataset.deleteFund);
    else if(target.dataset.editFund)openFund(getFund(target.dataset.editFund));
    else if(target.dataset.disableFund)disableFund(target.dataset.disableFund);
    else if(target.dataset.enableFund)enableFund(target.dataset.enableFund);
  });
  document.body.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.matches('[data-delete-entry]'))return deleteEntry(target.dataset.deleteEntry);
    if(target.id==='homeTaskLink'){const debt=$('#homeOverdraftSection'),pending=$('#homePendingSection');(debt.hidden?pending:debt).scrollIntoView({behavior:'smooth',block:'start'});return}
    if(target.matches('[data-overdraft-settle]'))return openOverdraftSettlement(target.dataset.overdraftSettle,target.dataset.overdraftSource);
    if(target.matches('[data-home-open-legacy]')){showPage('walletsPage');const fund=state.funds[0];if(fund)openWalletDetail(fund.id);return}
    if(target.matches('[data-handle-pending]'))return openPending(target.dataset.handlePending,target.dataset.pendingType==='legacy');
    if(target.matches('[data-pending-cancel]'))return cancelOccurrence(target.dataset.recordId,target.dataset.recordType==='legacy');
    if(target.matches('[data-cancel-occurrence]'))return cancelOccurrence(target.dataset.cancelOccurrence,false);
    if(target.matches('[data-cancel-legacy]'))return cancelOccurrence(target.dataset.cancelLegacy,true);
    if(target.matches('[data-balance-transfer]'))return openBalanceTransfer(target.dataset.balanceTransfer);
    if(target.matches('[data-transfer-all]'))return transferAllAvailable();
    if(target.matches('[data-extra-deposit]'))return openExtraDeposit(target.dataset.extraDeposit);
    if(target.matches('[data-savings-expense]'))return openSurplusExpense();
    if(target.matches('[data-savings-detail]'))return openSavingsDetail();
    if(target.matches('[data-account-action]'))return openAccountEntry(target.dataset.accountId,target.dataset.accountAction);
    if(target.matches('[data-account-detail]'))return openAccountDetail(target.dataset.accountDetail);
    if(target.matches('[data-account-edit]'))return openAccountSetup(getAccount(target.dataset.accountEdit));
    if(target.matches('[data-edit-rule]'))return openRule(state.rules.find(r=>r.id===target.dataset.editRule));
    if(target.matches('[data-stop-rule]'))return stopRule(target.dataset.stopRule);
    if(target.matches('[data-rebind-rule]'))return rebindRuleToWallet(target.dataset.rebindRule,target.dataset.wallet);
    if(target.matches('[data-bind-legacy-plan]'))return bindLegacyPlan(target.dataset.bindLegacyPlan,target.dataset.wallet);
    if(target.matches('[data-bind-legacy-due]'))return bindLegacyDue(target.dataset.bindLegacyDue,target.dataset.wallet);
    if(target.matches('[data-confirm-legacy-due]'))return confirmLegacyDue(target.dataset.confirmLegacyDue);
    if(target.matches('[data-skip-legacy-due]'))return skipLegacyDue(target.dataset.skipLegacyDue);
  });
  $('#detailPeriod').addEventListener('change',renderWalletDetail);$('#detailCycle').addEventListener('change',renderWalletDetail);
  $('#addRuleBtn').addEventListener('click',()=>openRule());$('#ruleForm').addEventListener('submit',event=>{event.preventDefault();saveRule()});
  $('#accountSetupForm').addEventListener('submit',event=>{event.preventDefault();saveAccountSetup()});$('#accountType').addEventListener('change',updateAccountSetupFields);
  $('#accountEntryForm').addEventListener('submit',event=>{event.preventDefault();saveAccountEntry()});$('#accountAction').addEventListener('change',updateAccountEntryFields);$('#accountCreditMode').addEventListener('change',updateAccountCreditPreview);['#accountPersonalAmount','#accountCompanyAmount','#accountMedicalAmount'].forEach(id=>$(id).addEventListener('input',updateAccountCreditPreview));
  $('#pendingForm').addEventListener('submit',event=>{event.preventDefault();resolvePending()});$('#transferForm').addEventListener('submit',event=>{event.preventDefault();saveBalanceTransfer()});$('#extraDepositForm').addEventListener('submit',event=>{event.preventDefault();saveExtraDeposit()});$('#deleteFundForm').addEventListener('submit',event=>{event.preventDefault();commitFundDeletion()});$('#deleteFundMode').addEventListener('change',updateDeleteFundFields);$('#overdraftSettleForm').addEventListener('submit',event=>{event.preventDefault();saveOverdraftSettlement()});$('#disableFundFromDelete').addEventListener('click',()=>disableFund($('#deleteFundId').value));
  $('#confirmAccept').addEventListener('click',()=>{const action=confirmAction;confirmAction=null;closeModal('confirmModal');if(action)action()});
  $('#backupBtn').addEventListener('click',exportData);$('#importBtn').addEventListener('click',requestImport);$('#importFile').addEventListener('change',event=>importDataFile(event.target.files[0]));
  $$('.color-options').forEach(container=>container.addEventListener('click',event=>{const button=event.target.closest('[data-color]');if(!button)return;selectedColor=button.dataset.color;$$('.color-choice',container).forEach(item=>item.classList.toggle('selected',item.dataset.color===selectedColor))}));
  $$('[data-close]').forEach(button=>button.addEventListener('click',()=>closeModal(button.dataset.close)));
  $$('.modal-backdrop').forEach(backdrop=>backdrop.addEventListener('click',event=>{if(event.target===backdrop)closeModal(backdrop.id)}));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')$$('.modal-backdrop.open').forEach(modal=>closeModal(modal.id))});
}

bindEvents();
if(!onboardingNeeded&&!storageBlocked){reconcileScheduledCycles();reconcileDueRules();persist(false)}
render();
initOnboarding();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!onboardingNeeded&&!storageBlocked){reconcileScheduledCycles();reconcileDueRules();persist()}});
window.addEventListener('focus',()=>{if(!onboardingNeeded&&!storageBlocked){reconcileScheduledCycles();reconcileDueRules();persist()}});
setInterval(()=>{if(!document.hidden&&!onboardingNeeded&&!storageBlocked){const before=state.lastScheduledAt;reconcileScheduledCycles();const dueChanged=reconcileDueRules();if(before!==state.lastScheduledAt||dueChanged)persist();else render()}},60000);
if(!nativeStorage&&'serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
function syncVisualViewport(){
  const viewport=window.visualViewport,height=viewport?.height||window.innerHeight;
  document.documentElement.style.setProperty('--visual-height',`${height}px`);
  document.documentElement.style.setProperty('--keyboard-inset',`${Math.max(0,window.innerHeight-height-(viewport?.offsetTop||0))}px`);
}
syncVisualViewport();window.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('scroll',syncVisualViewport);
document.addEventListener('focusin',event=>{if(!event.target.matches('input,select,textarea'))return;setTimeout(()=>{if(event.target.closest('.modal,.onboarding'))event.target.scrollIntoView({block:'nearest',inline:'nearest'})},180)});
