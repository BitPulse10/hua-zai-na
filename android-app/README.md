# 留一笔 Android

Android 安装包在设备上离线运行网页记账界面。WebView 只从 APK 内的白名单资源加载 `index.html`、`app.js`、`styles.css`、`icon.svg`、`manifest.json`，以及上级目录中存在时的 `android-runtime.js`；Gradle 每次构建时从上级项目目录同步，不维护另一份静态网页。页面使用 `https://budget-pocket.local/` 本地虚拟域名映射 APK assets，不启用 `file://`、通用文件访问或网络权限。Android 桥由当前 `app.js` 直接调用。

新装版本没有预置账本。当前账本和首次设置草稿分别以私有原子 JSON 文件保存。旧版 `liuyibi.db` 仅在文件存在时通过 SQLite 只读打开，旧数据库及偏好不会被迁移器修改或删除。

## 构建正式 APK

需要 Android SDK Platform 35、Build Tools 35 和 JDK 17。先配置 `local.properties` 的 `sdk.dir`，然后执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build-release.ps1
```

依赖已预先缓存时可加 `-Offline`，避免 Gradle 检查网络元数据。

正式 APK 使用稳定包名 `cn.liuyibi.budget.offline`，可与旧版 `cn.liuyibi.budget` 并存。首次运行会在 `local-signing/` 创建持久 release keystore，并在被 Git 忽略的 `signing.properties` 保存本地签名设置。每次构建都会要求 release 签名、运行 Android `apksigner verify`，成功后输出到 `../delivery/留一笔-2.0.0.apk`。把 `local-signing/` 和 `signing.properties` 一并保存在安全备份中；丢失原签名密钥后，后续版本不能作为同一应用更新。

也可不生成本地密钥文件，改用 `LIUYIBI_RELEASE_STORE_FILE`、`LIUYIBI_RELEASE_STORE_PASSWORD`、`LIUYIBI_RELEASE_KEY_ALIAS` 和 `LIUYIBI_RELEASE_KEY_PASSWORD` 配置外部 keystore。

## 从旧版 APK 转移数据

旧的 `Liuyibi-Android.apk` 使用 Android debug 证书。兼容迁移包必须使用签名证书完全相同的原 debug keystore；脚本会在构建前核对证书，找不到匹配密钥时立即停止，不会生成或交付迁移包。可用 `-LegacyKeystore <路径>` 指定找回的密钥：

```powershell
.\build-legacy-upgrade.ps1
```

目前在项目和本机缓存中都未找到与旧 APK 证书匹配的 debug keystore，因此兼容迁移包暂不可构建。请保留旧应用安装状态及原 APK，不要卸载旧应用；正式版可并存安装，但它使用独立包名和私有沙箱，无法直接读取旧应用 SQLite。只有找回原 keystore 并通过脚本证书校验后，才能生成迁移包。届时兼容版首次打开会读取并转换旧账本，保留旧版全部钱包和记录。旧数据库也可能包含旧版预置数据，程序无法可靠区分示例与用户数据，因此会完整保留，不擅自删除。之后可在设置中用系统文件保存器导出 JSON，再导入正式版；迁移不会删除旧 SQLite 文件。

## 原生桥接口

仅虚拟域名页面可以调用 `AndroidLedger`：

- `readLedger()` 返回本机账本 JSON，首次安装返回空字符串。
- `saveLedger(json)` 使用 `AtomicFile` 同步保存，只有完成写入和磁盘同步才返回 `true`。
- `readSetupDraft()`、`saveSetupDraft(json)`、`clearSetupDraft()` 用于中断后恢复首次设置流程。
- `readLegacyLedger()` 只读返回旧版 `funds`、`entries` 和发薪偏好；旧数据库存在但读取失败时返回 `_nativeReadError`，不能当作空账本处理。
- `exportLedger(json, filename)` 和 `requestImport()` 分别用 Android SAF 保存、选择 JSON，并通过 `window.onNativeExportResult(success, message)`、`window.onNativeImportResult(json, error)` 回调页面。

SAF 操作不要求存储权限。系统返回键先交由网页关闭当前弹层或回到钱包页，再按正常方式退出；系统输入法优先处理自身返回键。页面视口应用状态栏、导航栏、刘海和键盘 Insets。
