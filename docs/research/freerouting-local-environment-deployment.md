# FreeRouting 本地环境部署方案分析

> 关联模块: `packages/dsh-tool-freerouting/src/runs/launcher.ts`
> 当前问题: FreeRouting 依赖 KiCad 安装目录下的 `start.bat`（含捆绑 JRE + JAR），用户需手动下载安装包，体验差且无法上线分发。

---

## 现状分析

### 当前启动流程

```
用户触发布线
  → RunService.route()
  → launcher.ensureUp()
  → probe(:37864) 是否存活
    → 存活: 直接布线
    → 不可达: findKicadBinWithStartBat()
      → 找到 <KiCad>\bin\freerouting_plugin\start.bat → spawnStartBat() → 轮询等待
      → 未找到 → 抛错 FREEROUTING_UNAVAILABLE
```

### 当前问题

| 维度 | 现状 | 上线障碍 |
|---|---|---|
| 环境来源 | 用户手动下载含 JRE+JAR 的压缩包 | 用户不知下什么、放哪里 |
| 环境发现 | 从 KiCad 安装目录找 `start.bat` | 强依赖 KiCad 安装路径，路径含中文/空格易出错 |
| Java 环境 | 捆绑在 start.bat 同目录的 JRE | 不可复用、不可独立升级 |
| 进程管理 | `cmd /c start "" "start.bat"` fire-and-forget | 无崩溃恢复、无优雅退出、无端口冲突检测 |
| 生命周期 | 启动后不管，DSH 退出也不关 | 僵尸 Java 进程、端口占用 |
| 版本管理 | 无 | 无法静默升级 FreeRouting |

---

## 三种方案概览

| 维度 | 方案 A: 预检+自动下载 | 方案 B: 插件自带 JRE 打包 | 方案 C: 独立安装器 |
|---|---|---|---|
| 核心思路 | 布线前检测环境，缺什么自动下载什么 | JRE+JAR 打进插件发布包 | 提供独立安装程序，一键安装环境 |
| 包体积增量 | 0（按需下载） | +110~200MB | 0（安装器独立分发） |
| 离线可用 | ❌ 首次需联网 | ✅ 完全离线 | ❌ 首次需联网 |
| 用户体验 | 无感（首次稍慢） | 无感 | 需额外一步安装 |
| 环境隔离 | 好（托管目录） | 最好（插件内） | 一般（系统级） |
| 升级灵活性 | 高（CDN 替换即生效） | 低（需发新版本插件） | 中（安装器更新） |
| 实现复杂度 | 中 | 低 | 高 |
| 适合场景 | 联网用户、快速迭代 | 离线/内网用户 | 企业级部署 |

---

## 方案 A: 预检 + 自动下载无感安装

### 核心思路

在布线前做环境预检（Java 环境、JAR 文件、服务状态），缺什么自动从 CDN 下载什么，安装到用户级托管目录，用户全程无感。

### 架构图

```
用户触发布线
  → launcher.ensureUp()
  → EnvChecker.check()
    ├─ :37864 存活? → 直接布线
    ├─ managedDir 有 JRE + JAR? → ProcessManager.start() → 布线
    └─ 缺失 → AutoInstaller.install()
        ├─ 有系统 Java 17+ → 只下载 JAR (~30MB)
        ├─ 无 Java → 下载 JRE+JAR bundle (~110MB)
        ├─ SHA256 校验
        ├─ 写入 version.json
        └─ ProcessManager.start() → 布线
```

### 目录结构

```
%APPDATA%/Huaqiu/freerouting/          # 用户级托管目录（无需管理员权限）
├── version.json                       # 安装版本清单
├── jre/                               # 托管 JRE（jlink 裁剪版 ~80MB）
│   └── bin/java.exe
├── app/
│   └── freerouting.jar                # FreeRouting 引擎 (~30MB)
├── logs/
│   └── freerouting-2026-09-18.log     # 服务日志
└── .lock                              # 安装锁（防并发）
```

### 环境预检流程

```
EnvChecker.check():
  1. 检查 managedDir/jre/bin/java.exe 是否存在
     → 存在: javaSource='managed', 直接用
     → 不存在: 执行 where.exe java → java -version → 检查 ≥ 17
       → 找到: javaSource='system', 用系统 Java
       → 没找到: javaSource='none', 需要下载 JRE
  2. 检查 managedDir/app/freerouting.jar 是否存在
     → 不存在: 需要下载 JAR
  3. HTTP GET :37864/v1/system/status
     → 200: serviceUp=true, 直接返回
     → 失败: serviceUp=false, 需要启动
  4. 检查磁盘可用空间 (GetDiskFreeSpaceEx)
     → < 300MB: 报 INSUFFICIENT_DISK_SPACE
```

### 自动安装流程

```
AutoInstaller.install(env):
  1. 获取 .lock 文件锁（proper-lockfile，防多实例并发安装）
  2. 二次检查（等锁期间可能另一个实例已装好）
  3. 磁盘空间预检 ≥ 300MB
  4. 按需下载:
     a. 无 JRE → 下载 jre-21-windows-x64-minimal.zip → 解压到 jre/
     b. 无 JAR → 下载 freerouting-{version}.jar → 放到 app/
  5. SHA256 校验（对比 CDN 上的 checksums.json）
  6. 写入 version.json
  7. 释放锁
  下载失败: 3 次重试 + 指数退避（1s → 2s → 4s）
```

### 生命周期管理

#### 启动

```
ProcessManager.start(javaPath):
  1. PortGuard.checkPort(37864) → 端口被占?
     → 被 FreeRouting 占用 → 健康检查确认 → 复用
     → 被其他进程占用 → 报 PORT_CONFLICT
  2. spawn(javaPath, ['-jar', jarPath, '--server.port=37864'])
     → stdio 重定向到 logs/ 目录
     → windowsHide: true（不弹黑窗口）
  3. 轮询健康检查（TCP connect :37864 → HTTP /v1/system/status）
  4. 超时 60s → 报 FREEROUTING_UNAVAILABLE
```

#### 运行中崩溃

```
child.on('exit', code, signal):
  code=0 / SIGTERM → 正常退出，不重启
  其他 → 崩溃:
    滑动窗口计数: 5 分钟内崩溃次数
    ≤ 3 次 → 指数退避重启（2s → 4s → 8s, 最大 30s）
    > 3 次 → 停止重启，报 CRASH_LOOP 错误
```

#### DSH 插件退出

```
plugin dispose():
  ProcessManager.gracefulShutdown():
    1. taskkill /PID {pid} /f /t（Windows 下 Java 的 shutdown hook 会执行）
    2. 等待 10s
    3. 仍未退出 → SIGKILL 强杀
    4. 清理 managed 引用
```

#### 端口冲突处理

```
PortGuard.checkPort(37864):
  netstat -ano -p TCP | findstr :37864 | findstr LISTENING
  → 找到 PID:
    wmic process where ProcessId={pid} get CommandLine
    → 包含 "freerouting" → 是残留 FreeRouting → 直接复用
    → 不包含 → 报 PORT_CONFLICT，提示用户关闭冲突程序
  → 未找到 → 端口空闲，可以启动
```

### 风险点

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| CDN 不可达 / 网络差 | 高 | 首次安装失败 | 3 次重试+指数退避；明确提示检查网络 |
| 磁盘空间不足 | 中 | 安装失败 | 安装前检查 ≥ 300MB；明确提示缺多少空间 |
| 杀毒软件拦截 JRE | 中 | JRE 被隔离/删除 | 用 Adoptium 有代码签名的 JRE；提示加白名单 |
| 路径含中文/空格 | 中 | Java 启动失败 | `%APPDATA%` 通常无此问题；spawn 用数组参数 |
| 并发安装冲突 | 低 | 文件损坏 | `.lock` 文件锁，一个装完另一个跳过 |
| 下载文件损坏 | 中 | JAR 加载失败 | SHA256 校验 + 失败自动删 + 重试 |
| 企业代理/防火墙 | 低 | HTTPS 下载失败 | 继承 Node.js `NODE_EXTRA_CA_CERTS` |
| FreeRouting 内存泄漏 | 中 | 长时间运行 OOM | 监控 RSS，超 2GB 主动重启 |
| Windows 休眠唤醒 | 低 | TCP 断开 | 健康检查自动检测，触发重启 |
| 多 DSH 实例 | 中 | 端口冲突 | 健康检查发现已有服务 → 复用不重复启动 |

### 优点

- ✅ 用户完全无感，点布线就自动搞定
- ✅ 智能判断：有 Java 只下 JAR (~30MB)，没 Java 下 bundle (~110MB)
- ✅ 安装到 `%APPDATA%`，一次安装永久缓存，无需管理员权限
- ✅ 不依赖 KiCad 安装目录，完全解耦
- ✅ CDN 替换 JAR 即升级，无需发新插件版本
- ✅ 包体积零增量

### 缺点

- ❌ 首次使用必须联网
- ❌ 首次下载等待 30s~2min（取决于网速）
- ❌ CDN 挂了全完（需要 CDN 高可用保障）

---

## 方案 B: 插件自带 JRE 打包

### 核心思路

用 `jlink` 从 JDK 21 裁剪出一个最小 JRE（只含 FreeRouting 需要的模块），和 FreeRouting JAR 一起打进插件发布包（`.tgz`）。插件启动时直接用内置 JRE 启动 JAR，零外部依赖。

### 架构图

```
@huaqiu/dsh-tool-freerouting/
├── bundled/
│   ├── jre/                          # jlink 裁剪的 mini JRE (~80MB)
│   │   ├── bin/java.exe
│   │   ├── lib/
│   │   │   ├── modules               # 合并后的模块文件
│   │   │   └── ...
│   │   └── conf/
│   └── freerouting.jar               # FreeRouting 引擎 (~30MB)
├── lib/
│   └── index.mjs                     # 插件代码
└── package.json
```

### jlink 裁剪命令

```bash
# 基于 JDK 21，只包含 FreeRouting 需要的模块
jlink \
  --module-path $JAVA_HOME/jmods \
  --add-modules \
    java.base,\
    java.desktop,\
    java.logging,\
    java.management,\
    java.naming,\
    java.net.http,\
    java.sql,\
    java.xml,\
    jdk.unsupported \
  --compress zip-6 \
  --strip-debug \
  --no-man-pages \
  --no-header-files \
  --output bundled/jre

# 验证
bundled/jre/bin/java -version
# 预期输出: openjdk version "21.x.x"
```

裁剪后 JRE 约 80MB（vs 完整 JRE ~300MB）。

### 启动方式

```typescript
// launcher.ts 改造 — 极简版
async function startFreerouting(): Promise<void> {
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  const javaExe = join(pluginRoot, '..', 'bundled', 'jre', 'bin', 'java.exe');
  const jarPath = join(pluginRoot, '..', 'bundled', 'freerouting.jar');

  // 直接启动，无需检测系统 Java
  const child = spawn(javaExe, ['-jar', jarPath, '--server.port=37864'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // ... 健康检查轮询
}
```

### 生命周期管理

与方案 A 的 ProcessManager 相同，但更简单：

| 事件 | 处理 |
|---|---|
| 启动 | 直接用 `bundled/jre/bin/java.exe -jar bundled/freerouting.jar` |
| 崩溃 | 同方案 A：指数退避重启，5min 内最多 3 次 |
| DSH 退出 | 同方案 A：gracefulShutdown → taskkill → SIGKILL |
| 端口冲突 | 同方案 A：PortGuard 预检 |

**不需要**：环境检测、下载安装、磁盘空间检查、SHA256 校验、安装锁。

### 风险点

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| **npm 包体积暴增** | 确定 | ~110MB | 不走 npm registry，用 CDN/GitHub Release 分发 |
| **每次更新都要重下** | 高 | 带宽浪费 | 增量更新只替换 JAR（jlink 产物稳定） |
| **jlink 模块不全** | 中 | FreeRouting 启动报 ClassNotFoundException | 充分测试所有路由功能；保留 `--add-modules` 冗余 |
| **跨平台** | 中 | JRE 是平台相关的 | 只支持 Windows（当前 DSH 只有 Windows）；其他平台按需打包 |
| **安全审计** | 低 | 捆绑二进制文件 | JRE 来源可追溯（Adoptium SHA256 公开） |
| **磁盘占用** | 确定 | 每个用户 ~110MB | 可接受，一次性 |
| **JAR 版本更新** | 高 | 需要重新打包发布 | CI 自动化：检测 FreeRouting 新版本 → jlink → 打包 → 发布 |
| **JRE 安全漏洞** | 低 | 需要紧急更新 | CDN 替换 + 插件启动时校验版本 |

### 优点

- ✅ **零网络依赖**，离线/内网完全可用
- ✅ **环境 100% 可控**，不存在 Java 版本兼容问题
- ✅ **实现最简单**，无需下载/安装/校验逻辑
- ✅ **启动最快**，无下载等待
- ✅ **无杀毒软件拦截风险**（随插件一起分发，非独立下载）

### 缺点

- ❌ **包体积 +110MB**，npm publish 不现实，需 CDN 分发
- ❌ **JRE 平台绑定**，macOS/Linux 需分别打包
- ❌ **更新笨重**，JRE 变更需重新打包整个 bundle
- ❌ **磁盘浪费**，用户机器上已有 Java 也得多带一份

---

## 方案 C: 独立安装器（一键安装程序）

### 核心思路

开发一个独立的 Windows 安装程序（NSIS/Inno Setup/Electron 安装包），用户首次使用时运行安装器，一键安装 JRE + FreeRouting 到系统目录。DSH 插件只负责检测已安装的环境并启动。

### 架构图

```
安装器（HuaqiuFreeRouting-Setup-1.8.0.exe）
  │
  ├─ 安装到 C:\Program Files\Huaqiu\FreeRouting\
  │   ├─ jre/bin/java.exe
  │   ├─ app/freerouting.jar
  │   ├─ freerouting-service.exe   # Windows Service 包装器
  │   └─ uninstall.exe
  │
  ├─ 注册 Windows Service（可选）
  │   └─ "Huaqiu FreeRouting" → 开机自启
  │
  └─ 写入注册表
      └─ HKLM\SOFTWARE\Huaqiu\FreeRouting\InstallDir

DSH 插件
  └─ launcher.ts
      ├─ 读注册表/检测安装目录
      ├─ 启动服务（或连接已运行的 Service）
      └─ 健康检查 → 布线
```

### 安装器功能

```
HuaqiuFreeRouting-Setup-1.8.0.exe (NSIS/Inno Setup, ~90MB):
  1. 欢迎界面 + 许可协议
  2. 选择安装目录（默认 C:\Program Files\Huaqiu\FreeRouting）
  3. 可选：注册为 Windows Service（开机自启）
  4. 安装 JRE + FreeRouting JAR
  5. 创建开始菜单快捷方式
  6. 注册卸载程序
  7. 可选：安装后自动启动服务
```

### DSH 插件检测逻辑

```typescript
// launcher.ts — 方案 C
async function findFreerouting(): Promise<{ javaPath: string; jarPath: string } | undefined> {
  // 1. 查注册表
  const installDir = await readRegistry(
    'HKLM\\SOFTWARE\\Huaqiu\\FreeRouting', 'InstallDir'
  );
  if (installDir && existsSync(join(installDir, 'app', 'freerouting.jar'))) {
    return {
      javaPath: join(installDir, 'jre', 'bin', 'java.exe'),
      jarPath: join(installDir, 'app', 'freerouting.jar'),
    };
  }

  // 2. 查默认安装路径
  const defaults = [
    'C:\\Program Files\\Huaqiu\\FreeRouting',
    'C:\\Program Files (x86)\\Huaqiu\\FreeRouting',
  ];
  for (const dir of defaults) {
    if (existsSync(join(dir, 'app', 'freerouting.jar'))) {
      return {
        javaPath: join(dir, 'jre', 'bin', 'java.exe'),
        jarPath: join(dir, 'app', 'freerouting.jar'),
      };
    }
  }

  // 3. 检查 Windows Service 是否已在运行
  const svcStatus = await runCommand('sc.exe', ['query', 'HuaqiuFreeRouting']);
  if (svcStatus.includes('RUNNING')) {
    // Service 模式：服务已在跑，直接健康检查
    return undefined; // 不需要启动，直接连
  }

  return undefined; // 未安装
}
```

### 生命周期管理

| 事件 | Service 模式 | 非 Service 模式 |
|---|---|---|
| 启动 | 服务已自启动，直接健康检查 | DSH 插件检测并启动进程 |
| 崩溃 | Windows Service 自动重启（SCM 配置） | 同方案 A：指数退避重启 |
| DSH 退出 | 服务继续运行（独立生命周期） | gracefulShutdown |
| 端口冲突 | Service 已占端口，直接复用 | PortGuard 检测 |
| 系统重启 | 自动随系统启动 | 需用户手动或等 DSH 启动 |
| 升级 | 运行新安装程序覆盖安装 | 同左 |
| 卸载 | 控制面板 → 卸载 | 同左 |

### 风险点

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| **需要管理员权限** | 确定 | 用户需 UAC 确认 | 可选安装到用户目录（不需要管理员） |
| **安装步骤打断用户流** | 高 | 体验割裂 | DSH 检测到未安装 → 弹窗引导下载 → 安装完回来 |
| **Service 模式复杂** | 中 | 安装器逻辑复杂 | Service 作为可选功能，默认不启用 |
| **注册表路径冲突** | 低 | 多版本共存问题 | 版本号写入注册表，安装器处理升级 |
| **安装器维护成本** | 高 | 需单独开发维护 | NSIS/Inno Setup 脚本需持续维护 |
| **分发渠道** | 中 | 用户需找到安装器下载链接 | DSH 内嵌下载链接 / KiCad 安装包捆绑 |
| **版本碎片化** | 中 | 不同用户不同版本 | DSH 插件检测版本，低版本提示升级 |
| **卸载残留** | 低 | 注册表/文件残留 | 安装器卸载时完整清理 |

### 优点

- ✅ **专业感强**，有安装向导、开始菜单、控制面板卸载
- ✅ **Service 模式**可实现开机自启、崩溃自动重启（OS 级）
- ✅ **系统级管理**，其他工具也可发现和使用 FreeRouting
- ✅ **升级/卸载标准化**，用户熟悉
- ✅ **可与 KiCad 安装包捆绑**，一次安装全搞定

### 缺点

- ❌ **开发成本最高**：需维护安装器脚本 + Service 包装器
- ❌ **用户体验割裂**：布线中途发现没装 → 跳出安装 → 回来继续
- ❌ **需要管理员权限**（安装到 Program Files 时）
- ❌ **版本更新慢**：用户不一定及时升级
- ❌ **Service 模式增加复杂度**：SCM 配置、权限、日志路径

---

## 三方案横向对比

### 用户体验

```
方案 A: 用户视角
  第一次点布线 → "正在准备环境... 下载中 67%... 环境就绪 → 布线中"
  第二次点布线 → 直接布线（<1s 检测）
  之后每次    → 直接布线

方案 B: 用户视角
  第一次点布线 → 直接布线（<2s 启动）
  每次        → 直接布线
  （完全无感）

方案 C: 用户视角
  第一次点布线 → "请先安装 FreeRouting 环境" → 下载安装器 → 安装向导 → 回来布线
  之后每次    → 直接布线（Service 模式）或 <2s 启动（非 Service 模式）
```

---

## 共性需求：生命周期管理（三方案通用）

无论哪种方案，以下进程管理能力是必须的：

### 1. 进程启动

```
启动方式优先级:
  1. :37864 已存活 → 直接复用（不区分谁启动的）
  2. 配置了 freeroutingStartBat → 旧路径兼容
  3. 托管目录有 JAR + JRE → ProcessManager.start()
  4. 自动安装 → 安装完 → ProcessManager.start()
  5. 全部失败 → 清晰错误 + 诊断信息
```

### 2. 健康检查

```
两级检查:
  Level 1: TCP connect :37864（< 100ms，确认进程在监听）
  Level 2: HTTP GET /v1/system/status（< 5s，确认应用层就绪）

启动时用 Level 2（确保可用）
运行中探活用 Level 1（快速检测崩溃）
```

### 3. 崩溃恢复

```
崩溃检测: child.on('exit') + 定时健康检查（每 30s）
重启策略: 指数退避（2s → 4s → 8s → 16s → 30s cap）
重启上限: 5 分钟内最多 3 次
超限处理: 停止重启，记录日志，后续布线请求报错 CRASH_LOOP
```

### 4. 优雅退出

```
DSH 插件 dispose():
  1. 检查是否有正在进行的布线任务
     → 有: 等待完成（或取消）后再关闭
     → 无: 直接关闭
  2. taskkill /PID {pid}（触发 Java shutdown hook）
  3. 等待 10s
  4. 仍未退出 → SIGKILL 强杀
  5. 清理日志文件句柄
```

### 5. 端口冲突

```
启动前:
  netstat -ano → 检查 :37864 LISTENING
  → 无: 正常启动
  → 有:
    wmic 查命令行 → 是 FreeRouting → 健康检查 → 复用
    wmic 查命令行 → 不是 FreeRouting → 报 PORT_CONFLICT
```

### 6. 日志管理

```
日志位置: %APPDATA%/Huaqiu/freerouting/logs/
日志格式: freerouting-YYYY-MM-DD.log
日志轮转: 保留最近 7 天，超过自动删除
日志内容: FreeRouting stdout + stderr + ProcessManager 事件
```
