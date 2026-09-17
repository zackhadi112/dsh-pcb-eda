# 分析:把 dsh-plugin-freerouting 迁移到 pcb-eda 的 gRPC 方式

> 关联对象:
> - 参考插件:`packages/dsh-eda-host`(本仓库)
> - 任务文档:`D:\project\hq-edge\docs\tasks\add-dsh-eda-host.md`
> - 待迁移插件:`D:\deepseek\kicad-freerouting-plugin\apps\dsh-plugin-freerouting`
> - 桥接参考:`D:\project\hq-edge\apps\server\src\routes\netlist.ts`、`.../src/grpc/clients.ts`

---

## 结论先行(TL;DR)

**方案可行,方向正确,而且插件侧已预埋抽象,替换是低风险的一环。** 但必须澄清一个关键歧义:

- **dsh-eda-host 插件本身并不说 gRPC**。它是一个"薄" HTTP 客户端,真正的 gRPC 在 hq-edge 里。
- 如果"改成一样的 gRPC 方式"指的是**在插件里直接跑 gRPC 连 KiCad**(即启用已有的 `kicad-proto-client.ts`),那**恰恰违背** dsh-eda-host 架构,属于任务文档 §13/§20 明令禁止的 `DSH → KiCad` 直连反模式。
- 如果指的是**真正照搬 dsh-eda-host 模式**(插件退化成薄 HTTP 客户端 → hq-edge 拥有语义 proto + gRPC → EDA Host 原生实现),那才是正确做法。

真正的工作量和风险不在插件,而在 **hq-edge 的语义 proto/路由** 与 **KiCad host 侧原生 gRPC 服务实现**,外加 freerouting 特有的 **长任务流式进度** 和 **跨进程字节交换** 这两个 netlist 从未面对的问题。

---

## 一、dsh-eda-host 是怎么实现的

完整链路(插件本身只发 HTTP,gRPC 属于 hq-edge):

```text
DSH / Agent Tool
   │  ctx.tools.register
   ▼
dsh-eda-host 插件
   │  HTTP fetch  /api/v1/netlist/{project|selection|active-page}
   ▼
hq-edge (Express 路由 netlist.ts)
   │  Connect-gRPC  (createGrpcTransport → EDA_GRPC_URL)
   ▼
EDA Host (KiCad / HQ EDA)
   │
   ▼
native EDA model
```

### 各层职责

| 层 | 拥有什么 | 绝对不碰什么 |
|---|---|---|
| **dsh-eda-host** | DSH 集成、tool 注册、把 tool 调用翻译成 hq-edge HTTP 请求 | KiCad 逻辑、原理图解析、host IPC、`@hqedge/*` 依赖 |
| **hq-edge** | 语义 protobuf 契约(`hq.ir.schematic.v1`)、编排、gRPC 传输 | KiCad 类、原理图文件解析 |
| **EDA Host** | 原生实现 `NetListService` gRPC 服务 | — |

### 插件侧实现要点("这个方式"的精髓)

1. **纯 HTTP,不引 gRPC 依赖**:`client.ts` 只用 `globalThis.fetch`,把 HTTP 状态码映射成语义错误
   (`412→FAILED_PRECONDITION`、`501→UNIMPLEMENTED`、`503→UNAVAILABLE`、其他 `→INTERNAL`)。
2. **不依赖 `@hqedge/*`**:`types.ts` 只是把 proto 形状用纯 TS 结构体"镜像"一份(唯一命名 wire shape 的地方)。
3. **base URL 懒解析**:`inject = ['hqEdge', 'tools']`,请求时优先读 edge-bridge HOST 注入的 `ctx.hqEdge.baseUrl`,
   其次 config overlay,最后 `HQ_EDGE_BASE_URL` 环境变量;没有 URL 就降级成清晰的 `FAILED_PRECONDITION`,而非加载时抛错。
4. **语义化空 vs 错误**:`ok:true` + 空 `components/nets` 是合法空设计,绝不把错误伪装成空结果。

### hq-edge 侧印证

`routes/netlist.ts` 用 `@hqedge/connect` + `createGrpcTransport({ baseUrl: config.EDA_GRPC_URL })` 生成 `cppNetListClient`,
把 gRPC 结果 `toJson` 后透传,并把 `ConnectError.code` 翻译成 HTTP 状态码(`FailedPrecondition→412`、`Unimplemented→501`、`Unavailable→503`)。

---

## 二、add-dsh-eda-host.md 的硬约束

- **§13 / §20 反模式**:禁止 `DSH → KiCad` 直连,禁止 `dsh-eda-host → KiCad-specific APIs`,禁止插件直接开 KiCad NNG socket。
  **唯一合法路径:DSH → dsh-eda-host → hq-edge → EDA Host。**
- **§2 协议语义化**:RPC 名要用 `GetProjectNetList` 这类语义名,禁止 `ExportKiCadNetlist`/`GetSCHScreen` 这类 KiCad 实现名。
- **§3 Out of scope**:那份任务显式把 "routing APIs"、"FreeRouting integration"、"PCB APIs" 列为不做。
  但 §23 结尾也说明:netlist 是刻意做小的第一刀,"同样的模式之后可以复用到 PCB facts、placement、routing"。

> 也就是说:**routing 走这套模式是被预期和鼓励的,但它是一个独立的、比 netlist 大得多的任务。**

---

## 三、freerouting 插件现状

**好消息:该插件已为迁移预埋了架构,不是从零开始。**

### 现状(`runtime.ts`)

直接 HTTP 打**两个**本地服务:

- **KiCad HTTP Bridge**(`:7080`,KiCad 里的 Python 插件):`export_dsn` / `import_session` / `fill_zones` / `revert_session` / `status` / `use_current`
- **FreeRouting 引擎**(`:37864`):异步布线 job

这恰好就是文档 §13/§20 禁止的 **"DSH → KiCad 直连"反模式**。

### 已预埋的迁移基础

1. **`kicad-upstream-interface.ts`** 定义了 `KicadUpstreamClient` 抽象接口,注释明确:
   *"`KicadBridgeClient`(HTTP,当前生产路径)和未来的 `HqEdgeKicadClient`(hq-edge proto/gRPC)都实现这个契约,好让 `RunService` 透明切换传输"*。
2. **`RunService` 依赖接口而非具体类**(构造参数 `bridge: KicadUpstreamClient`)——换传输层低风险。
3. **`kicad-proto-client.ts`** 已写了一个 gRPC 客户端(`@grpc/grpc-js` + `proto-loader`,加载 `proto_definitions/kicad.proto`,调 `kicad.ipc.BoardService`)。
   但注意:**它目前未被 `runtime.ts` 引用(休眠状态),引用的 proto 文件在仓库里不存在,方法签名也和 `KicadUpstreamClient` 接口对不上。**

---

## 四、"改成一样的 gRPC 方式"——必须先澄清的歧义

### 理解 A:在插件里直接跑 gRPC 连 KiCad(启用 `kicad-proto-client.ts`)

- 技术上最简单(代码写了一半),**但违背 dsh-eda-host 架构**:插件直连 KiCad gRPC = §20 禁止的 `DSH → KiCad` 直连,只是把 HTTP 换成 gRPC。
- **结论:这不是"和 dsh-eda-host 一样",而是相反。**

### 理解 B:真正照搬 dsh-eda-host 模式(实际想要的)

- freerouting 插件退化成薄 DSH 插件,只 HTTP 调 hq-edge;
- hq-edge 新增语义 proto(如 `hq.services.v1.BoardRoutingService`:导出 DSN、导入 SES、填铜、回滚、状态),生成 Connect 绑定,加 gRPC client 和 Express 路由(照抄 `netlist.ts`);
- EDA Host / KiCad 侧原生实现这个 gRPC 服务(替代/包装现有 Python HTTP Bridge)。
- **结论:架构正确、可行,但工作量主要不在插件里。**

---

## 五、可行性评估(按理解 B)

### ✅ 低风险 / 已就绪

- 插件侧传输替换:`KicadBridgeClient` → 新写 `HqEdgeKicadClient implements KicadUpstreamClient`(内部 `fetch` 打 hq-edge,base URL 从 `ctx.hqEdge.baseUrl` 懒解析)。`RunService` 不用改。
- hq-edge 已有成熟的 HTTP↔gRPC 桥接范式(`netlist.ts` + `grpc/clients.ts`)可直接照抄。
- 插件 `inject` 加一个 `hqEdge` 即可,`cordis.patch.yml` 相应调整。

### ⚠️ 真正的难点(netlist 从没遇到过)

1. **两个上游,不是一个**:netlist 只桥 KiCad;freerouting 还要桥 FreeRouting 引擎(`:37864`)。
   需决定:FreeRouting 也搬到 hq-edge 后面,还是保留插件直连?hq-edge 现在**没有任何 routing 服务**(proto 里只有 place/canvas_ops/project/drc 等),这块语义契约要从零设计。
2. **长任务 + 流式进度**:netlist 是一次性 unary;freerouting 是"导出 DSN → 入队 → 轮询 RUNNING 并把中间 SES 实时导回 KiCad → 最终 SES 导入"的长流程。
   dsh-eda-host 那套"一次 fetch 返 JSON"覆盖不了流式/长任务语义,hq-edge 得额外暴露 job API 或 server-streaming gRPC。插件现有的 `RunStore`/`RunService`/`jobs`/`webServer`/浏览器卡片 UI **不会消失**,只是 KiCad 传输层被换掉。
3. **文件系统路径假设会被打破**:现在 Bridge 收本地文件 `path`(DSN/SES 落盘),因为 DSH host、Bridge、KiCad 同机。
   走 hq-edge gRPC 跨进程/跨机后不能再传路径,得传字节(base64)。FreeRouting client 已是 base64 交换,`kicad-proto-client.ts` 的 `ExportDSN` 也返回 `dsnContent` 而非路径,方向对,但语义契约要统一成 byte-based。
4. **依赖洁净度**:dsh-eda-host 强调不引 `@grpc/grpc-js`、不引 `@hqedge/*`。真按它的方式做,现有的 `kicad-proto-client.ts`(引了 `@grpc/grpc-js`+`proto-loader`)**应被删掉而非启用**——它是理解 A 的产物,与 dsh-eda-host 模型冲突。

---

## 六、推荐落地路径(分阶段,降风险)

建议**只把 KiCad 传输层按 dsh-eda-host 模式迁到 hq-edge,FreeRouting 引擎暂时保留直连**,先拿架构合规收益又不炸掉整条异步流程:

| 阶段 | 内容 | 仓库 |
|---|---|---|
| **1. 定契约** | 在 `platform/proto/hq/services/v1/` 新增语义化 board/routing proto(方法名用 `ExportBoardDsn`/`ImportRoutingSession`/`FillZones`/`RevertSession`/`GetBoardStatus`,**不出现 KiCad 字样**),buf 生成 Connect 绑定 | hq-edge |
| **2. 加桥接** | 照抄 `netlist.ts` + `grpc/clients.ts`,新增 Express 路由(如 `/api/v1/board/*`)和 `cppBoardClient`,复用 `ConnectError → HTTP status` 映射,字节用 base64 传 | hq-edge |
| **3. host 实现 gRPC** | 把现有 Python HTTP Bridge 能力用 gRPC server 暴露成上述语义服务(可先包一层,内部仍调原逻辑)。**最重的一环** | KiCad host |
| **4. 插件换传输** | 新写 `HqEdgeKicadClient implements KicadUpstreamClient`(fetch → hq-edge,base URL 从 `ctx.hqEdge.baseUrl` 懒解析),`runtime.ts` 用它替换 `KicadBridgeClient`;`inject` 加 `hqEdge`;删掉休眠的 `kicad-proto-client.ts`。`RunService`/RunStore/jobs/UI 全部不动 | freerouting 插件 |
| **5. 端到端 + 打包测试** | 验证 DSH → hq-edge → EDA host 全链路,再评估要不要把 FreeRouting 引擎也收进 hq-edge | 全部 |

---

## 七、一句话总结

**可行,方向正确。** 插件侧已有 `KicadUpstreamClient` 抽象在等,替换低风险。但务必按"理解 B"来做(插件保持薄 HTTP、gRPC 归 hq-edge),否则启用 `kicad-proto-client.ts` 直连 KiCad 反而违反 dsh-eda-host 架构原则。真正的工作量与风险在 hq-edge 的语义 proto/路由,以及 KiCad host 侧原生 gRPC 服务实现,再加上 freerouting 特有的**长任务流式进度**与**跨进程字节交换**这两个 netlist 从未面对的问题。
