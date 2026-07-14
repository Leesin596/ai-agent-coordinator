---
name: go-development
description: Go 规范基线与排障证据链技能。用于 .go、go.mod、go.work、net/http、chi、Gin、GORM、Cobra CLI、goroutine/channel、context、race、fuzz、pprof、testcontainers、govulncheck、golangci-lint、gosec、GoReleaser/SBOM/OpenVEX、Go module/workspace、project-layout 相关任务；强调 Effective Go/Uber 风格、证据先行、生命周期收口和相邻技能边界。
---

# Go 开发

Go 开发（go-development，兼容 slug: godv）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

定位：先用 Go 官方与社区成熟实践建立“可维护、可测试、可发布”的规范基线，再用证据链定位并发、性能、依赖、Web、DB、CLI 与发布问题。禁止凭框架偏好或经验口诀替代 `go test`、race、pprof、日志、依赖与调用方证据。

## 使用边界

- 命中：Go 代码、go.mod/go.work、module/toolchain、net/http、chi、Gin、GORM、Cobra、并发、context、错误处理、测试、fuzz、pprof、构建发布与 Go 供应链。
- 联动：API 契约/状态码/认证语义交 api；schema/迁移/索引/数据修复交 db；CORS/CSRF/SSRF/OAuth/JWT 等深层安全交 wsec；CI/CD/镜像/回滚交 rls；SAST/SBOM/OPA/供应链策略交 dso；线上 SLO/告警/容量交 obs；最终影响面交 aud。
- 输出必须写证据：Go 版本、GOTOOLCHAIN、GOOS/GOARCH、CGO_ENABLED、GOMOD/GOWORK、入口、受影响包、验证命令；未运行不得写“已验证”。

## 单技能铁律：先防低级错

- 禁止“能跑就算完成”：每次新增/修改 Go 功能都要交付入口、数据模型、错误出口、并发/资源收口、测试或不可测原因、回滚点。
- 禁止让 handler 直接拼业务：HTTP/CLI/worker 入口只做解析、鉴权上下文、调用 domain/service、响应映射；业务规则不能散落在 binding、router 或 ORM hook 里。
- 禁止 DTO、Entity、Domain、Repo 混用：外部请求 DTO 不直接写 DB；DB entity 不直接返回给用户；domain model 承载业务不变量；repo 只表达持久化意图和错误语义。
- 禁止 mass assignment：不能把请求体整包 bind 到持久化结构或 `map[string]any` 后直接 `Updates`；允许更新字段必须白名单化，权限字段、状态机字段、归属字段由服务端计算。
- 禁止忽略输入严格性：JSON decoder/binding 要处理未知字段、重复字段、空 body、过大 body、类型不匹配、时间格式、数组长度和字符串裁剪；是否允许 unknown fields 必须有兼容理由。
- 禁止 Go 零值误判：Create、PUT、PATCH、Query 的零值含义分别确认；PATCH 必须有三态表达，不能把 `false/0/""` 当未传。
- 禁止跨层吞错：repo 不返回“成功但 0 行”；service 不把权限不可见、资源不存在、版本冲突、幂等重复、校验失败、外部超时都压成同一种错误。
- 禁止无边界 goroutine：后台任务必须有 owner、ctx、退出条件、panic 兜底、err/metric/log 出口；ticker、timer、body、rows、cancel 必须释放。
- 禁止配置和 secret 漂移：配置从 env/file/flag 读取要有默认值、必填校验和启动日志摘要；secret/token/password/key 不进仓库、不进普通日志、不进错误响应。
- 禁止无证据发布：发布前至少说明 `go test`/race/lint/govulncheck/集成测试/手工 smoke 哪些已跑、哪些未跑和原因。

## 第一层：规范基线（改前先对齐）

### 0. 需求到 Go 落地门禁

- 开始前先写清：用户动作、业务对象、入口类型（HTTP/CLI/worker/lib）、读写资源、权限边界、幂等要求、成功响应、失败语义、并发/事务风险、验收样本。
- 先搜现有模式：router/handler、service/usecase、repository/store、model/entity、DTO、error mapper、middleware、config、logger、test fixture；新代码要贴合项目已有分层。
- 最小闭环：新增功能至少覆盖 DTO/validator、domain/service、repo/外部 client、错误映射、日志字段、测试样本；缺任一环节要在输出中点明。
- 影响面确认：改公共类型、接口、路由、错误码、DB 字段、生成产物、配置项、goroutine、消息 topic 时先搜调用方和部署配置。
- 输出必须能复验：列出修改文件、入口、核心路径、验证命令、关键测试名、手工请求样本或无法运行原因；禁止只说“应该可以”。

### 1. 版本、module 与目录

- 先读：`go version`、`go env GOVERSION GOTOOLCHAIN GOOS GOARCH CGO_ENABLED GOMOD GOWORK GOPROXY GOSUMDB GOPRIVATE GONOSUMDB GONOPROXY`、`go.mod`、`go.work`、`replace`、`exclude`、`toolchain`。
- 官方优先：优先遵循 Go module layout、`internal/` 封装、`cmd/<app>/main.go` 多入口、包按能力和依赖方向组织。
- `project-layout` 说明：`github.com/golang-standards/project-layout` 非官方、不是标准；只作大型项目参考，按需采用，不能压过官方 module layout、`internal`、`cmd` 与简单结构优先原则。
- go.work 会改变解析；本地 workspace 通过不代表单模块 CI 通过。提交前要在目标 module 环境跑 `go test ./...` 或说明无法跑原因。

### 2. Effective Go / Uber 风格基线

- 命名：包名短小小写、避免 `util/common/base` 泛化；导出名表达语义并配 doc；initialism 一致（ID/HTTP/URL）；变量名随作用域缩短，不牺牲含义。
- 包设计：禁止循环依赖；依赖从业务入口流向底层能力；不要让 handler、repository、model 互相偷调；公共 API 变更先搜调用方。
- 接口：接口放在消费方，优先小接口；不要为 mock 过早抽象生产代码；返回具体类型、接收接口通常更易演进；泛型只用于真实类型族复用。
- 错误：底层保留根因，上层翻译语义；用 `%w`、`errors.Is/As`、`errors.Join`；不要只拼字符串或丢弃错误；日志不等于处理。
- panic：library 不用 panic 表达可恢复错误；server/worker 的 recover 只能兜底并记录 request_id/stack，不能吞掉根因或返回假成功。
- goroutine 生命周期：每个 goroutine 必须有 owner、退出条件、context 或 channel 收口、错误出口；禁止无限 fan-out、泄漏 ticker、无人接收发送阻塞。
- 资源关闭：`defer rows.Close()`/body.Close/Stop ticker/CancelFunc 必须可见；锁内不做网络、磁盘、慢日志或回调。
- 分层：DTO 只表达输入输出契约；entity 只表达持久化结构；domain/service 维护业务不变量和状态流转；repo/client 封装外部依赖；禁止跨层复用导致敏感字段外泄或绕过校验。

### 3. Web 路线：stdlib net/http + chi + Gin

- 默认路线不只 Gin：小到中型服务优先评估 stdlib `net/http` 与 Go 1.22+ ServeMux；需要轻量路由/中间件时可选 chi；已有 Gin 项目按 Gin 证据链治理。
- `net/http` 基线：显式 `http.Server` ReadHeaderTimeout、ReadTimeout、WriteTimeout、IdleTimeout、MaxHeaderBytes、Shutdown；handler 传 `r.Context()`；client 必须有 Timeout/Transport 超时。
- chi 基线：确认路由树、中间件顺序、URL 参数、request scoped value、recoverer、timeout、body limit；错误出口统一。
- Gin 基线：确认 route group、中间件顺序、binding/validation、body size、trusted proxy、recovery、CORS/auth 位置、错误响应出口；Gin 不能作为唯一 Web 默认或绕过 stdlib 规则。
- 输入基线：请求体大小限制、Content-Type、JSON unknown fields、字段白名单、validator 错误、路径/查询参数归一化、分页上限、排序字段白名单、上传文件名清洗都要有明确处理。
- 响应基线：错误响应走统一 mapper；不要把内部 err、SQL、panic、secret、堆栈给用户；成功响应不要直接暴露 DB entity 或权限字段。
- API 契约变化必须转 api；认证授权、CORS/CSRF/SSRF 转 wsec。

### 4. CLI / worker / consumer

- Cobra CLI：适合多命令、flag、completion、config 的 CLI；命令必须有 context 根、信号处理、退出码、stderr/stdout 边界、可测试 RunE。
- worker/consumer：`signal.NotifyContext`、graceful shutdown、停止接新任务、等待 in-flight、ack/offset、retry/backoff、幂等键、DLQ 都要有证据。
- 禁止收到 SIGTERM 后继续拉取任务；禁止没有上限和退避的重试。

### 5. 数据访问：database/sql 与 GORM

- `database/sql`：记录 MaxOpenConns、MaxIdleConns、ConnMaxLifetime、ConnMaxIdleTime、WaitCount/WaitDuration；pool 配置要按 DB max connections、pod 数、worker 数计算。
- GORM：检查 Model tag、soft delete、preload/association、hooks、logger、RowsAffected、ErrRecordNotFound、批量 Update/Delete WHERE；preload 不是权限过滤。
- Go 字段更新契约卡：PATCH DTO 必须区分“未传、传零值、传 null、清空值”；优先用指针、`sql.Null*`、自定义 Optional 或 field mask 表达存在性，禁止把 Go 零值直接当“未更新”。GORM `Updates(struct)` 默认跳过零值，零值更新要用 map、Select/Omit 或显式字段；所有 Update/Delete 必须有 WHERE 或明确全表意图，检查 RowsAffected，区分 0 行、ErrRecordNotFound、唯一键/外键/校验错误、软删除命中与权限不可见。soft delete 默认过滤会影响查询和更新判断，只有在恢复、审计、后台修复等明确场景才允许 Unscoped，并必须记录影响面、回滚点和测试证据；错误映射要把 not found、conflict、validation、permission、db timeout/deadlock 分开，禁止统一吞成成功或 500。
- Repo 基线：repo 方法名表达业务查询意图；必须接收 context；返回领域可理解的错误；查询要包含租户/归属/权限过滤所需条件；不要让调用方拼 SQL/GORM 链绕过封装。
- 事务与幂等：事务边界从 service/usecase 发起并尽量短；同一事务内所有 repo 使用同一个 tx；幂等键、唯一约束、版本号/乐观锁、去重表或业务状态机要能解释重复请求结果。
- 事务只包 DB 原子区；不要在事务内做外部 HTTP/消息发送；schema/索引/迁移/回滚交 db。

### 6. 测试与质量门禁

- 单元：table-driven tests 覆盖正常/边界/错误；错误链用 `errors.Is/As` 断言。
- HTTP：`httptest` 覆盖 method/path/header/body/status/error response，超时与取消路径要测或说明无法自动化。
- 并发：共享状态跑 `go test -race ./...`；复杂输入优先 fuzz；性能改动补 benchmark baseline。
- 集成：DB/队列/外部依赖优先 testcontainers 或可重复环境；flaky test 定位时钟、并发、网络、全局状态根因。
- lint：golangci-lint 作为本地/CI 聚合门禁，规则以团队基线为准；gosec/SARIF 用于安全扫描与代码平台展示，发现需按证据分级，不能机械全改。
- 需求验收：新增业务至少覆盖成功、参数错误、权限/归属错误、not found、冲突/重复提交、外部依赖失败、DB 0 行或事务失败；没有自动化时给出可复现 curl/命令样本。
- CI 前自检：`gofmt`/`go vet`/`go test ./...` 是最低线；有并发跑 race，有依赖变更跑 `go mod tidy` 与 `go mod verify`，有公开入口跑 smoke。

### 7. 供应链、发布与生态

- Go 供应链基线：`go mod verify`、`go list -m -u -json all`、`govulncheck ./...`、GOPRIVATE/GONOSUMDB/GONOPROXY、工具依赖 pin 版本。
- GoReleaser：适合多平台二进制、checksum、签名、Docker image、Homebrew/Scoop 等发布；发布策略和回滚转 rls。
- SBOM/OpenVEX：发布制品需要可追踪组件和漏洞可利用性声明时纳入；策略归 dso，Go 技能负责 module、版本、构建证据。
- awesome-go 只作生态索引，不作为选型结论；选型必须补维护状态、许可、API 稳定性、依赖面和替代方案证据。

## 第二层：排障证据链（按场景取证）

### A. module / toolchain / CI 红绿不一致

- 取证：`go version`、`go env`、`go list -m all`、`go env -w` 痕迹、CI 镜像、缓存 key、go.mod/go.work、私有模块配置。
- 判断：Go 1.22 loop variable 语义、Go 1.23 timer/ticker 行为、Go 1.24 toolchain/module 变化、GOTOOLCHAIN=auto 是否导致漂移。
- 处理：固定 go/toolchain 策略，清理错误 replace/exclude，验证单模块环境；输出本地/CI 差异和命令。

### B. context cancellation、timeout、HTTP 故障

- 取证：入口 context、deadline、取消路径、HTTP client/server timeout、trace/request id、连接池、慢请求日志。
- 判断：禁止业务链用 `context.Background()`；区分用户取消、上游超时、内部 timeout、server shutdown。
- 处理：handler 传 `r.Context()`，后台任务显式脱钩并记录原因；server/client timeout 显式配置；回归 httptest 或集成测试。
- 门禁：每个外部调用、DB 查询、锁等待、消息处理都要能说明 timeout 来源；新开后台 context 要写清脱钩原因和生命周期。

### C. goroutine leak、channel、锁与竞态

- 取证：goroutine 创建点、退出条件、channel close owner、WaitGroup/errgroup 生命周期、mutex 范围、pprof goroutine dump、`go test -race`。
- 判断：发送方通常负责 close；range channel 必须有关闭或 ctx 退出；共享 map/slice/对象必须有同步或所有权串行化。
- 处理：补 ctx/select 退出、errgroup、单一 close owner、锁范围最小化；输出泄漏前后 goroutine 数、race 报告、阻塞栈。
- 门禁：禁止在请求路径中无上限启动 goroutine；禁止 goroutine 内只 log 不返回错误；禁止 ticker 没有 Stop、timer 没有 drain 语义确认。

### D. error wrapping、panic、日志

- 取证：错误链、哨兵错误、外部错误码、日志字段、用户可见响应、recover 点。
- 判断：保留根因和可匹配性；`errors.Join` 多错误语义要补调用方测试；panic 只兜底不可替代错误处理。
- 处理：底层 `%w`，边界层映射业务语义；slog 字段化 err/op/component/request_id，敏感字段脱敏。
- 门禁：日志字段固定包含 op/component/request_id/user_or_tenant 可用维度；password/token/secret/cookie/Authorization/身份证/手机号等敏感值必须脱敏或不记录。

### E. Gin / chi / net/http 路由问题

- 取证：路由表、中间件顺序、body limit、binding/validation、trusted proxy、CORS/auth/recovery/error 出口。
- 判断：框架默认行为不能替代安全和契约；ServeMux/chi/Gin 路由匹配差异要用请求样本验证。
- 处理：统一错误出口、输入限制、timeout、request id；契约和鉴权问题转相邻技能。
- 门禁：不能只测 happy path；必须覆盖 bad JSON、unknown field、缺 header、越权资源、超大 body、方法不匹配和取消请求中的相关项。

### F. GORM / SQL / 事务

- 取证：driver、pool stats、事务边界、慢查询、锁等待、GORM logger SQL、RowsAffected、ErrRecordNotFound、soft delete、hooks。
- 判断：context timeout 不等于 SQL 已取消；事务内外部调用放大锁等待；忽略 RowsAffected 会造成静默误判。
- 处理：调整 pool 要有容量计算；事务只保留原子区；批量更新/删除必须 WHERE、影响行数、回滚方案。

### G. pprof、trace、benchmark、内存

- 取证：CPU/heap/block/mutex profile、trace、benchmark baseline、allocs/op、GC 日志、线上负载特征。
- 判断：没有 baseline 不做性能结论；不要用微优化掩盖架构瓶颈；pprof 单张截图不足以证明修复。
- 处理：同环境前后对比，定位热点后改算法/分配/锁竞争；线上观测转 obs。

### H. fuzz、解析器、兼容输入

- 取证：parser/decoder、JSON/form/upload、时间/零值、未知字段、历史样本、崩溃输入。
- 判断：Go 零值不等于未传；时间必须明确 UTC/业务时区；复杂输入优先 fuzz。
- 处理：补 `FuzzXxx`、种子语料、最小复现；API 兼容语义转 api。
- 门禁：JSON decode 失败要区分语法错、类型错、未知字段、空 body、多个 JSON 值；PATCH 三态和历史兼容必须有测试样本。

### I. 生成代码与契约产物

- 取证：`// Code generated ... DO NOT EDIT.`、`.pb.go`、mock、sqlc、ent、OpenAPI 产物、`go generate`、Makefile、buf、sqlc.yaml、ent schema。
- 判断：禁止直改 generated；生成器版本、schema、模板和产物必须匹配。
- 处理：改源 schema/config 后重新生成；无法生成就停下列缺口。

### J. CGO、static binary、多平台发布

- 取证：GOOS/GOARCH、CGO_ENABLED、libc、证书、时区、DNS、基础镜像、`-trimpath`、`-ldflags`、`go version -m <binary>`。
- 判断：static binary 不等于无运行时依赖；CGO 影响 DNS、sqlite、openssl、musl/glibc、交叉编译。
- 处理：明确 CGO 和镜像策略；multi-arch 分别烟测；GoReleaser/SBOM/OpenVEX 证据随发布链交接。

## 高频反例

- 需求只写 handler 和 repo，没写 service/domain：业务不变量散落在入口和 ORM，下一次复用会绕过校验。
- 请求 DTO 直接复用 DB entity：用户可提交 id/status/role/tenant_id 等服务端字段，形成 mass assignment。
- `ShouldBindJSON(&model)` 后直接 `db.Save(&model)`：未知字段、零值、权限字段、状态机字段全失控。
- PATCH 用普通 struct：`false/0/""` 被当成未传，或者未传字段被覆盖为空，必须三态化。
- JSON decoder 默认接受 unknown fields：字段拼错也成功，前后端以为已生效。
- handler 内用 `context.Background()` 调 DB：会切断取消链，必须传 `r.Context()` 并设置下游 timeout。
- 默认 HTTP client/server timeout：可能无限等待或被慢连接拖垮，公网服务必须显式配置。
- 启动 goroutine 后只发送结果：接收方退出会阻塞泄漏，必须 select ctx.Done 或有缓冲/收口协议。
- 多个发送方 close channel：close owner 不清会 panic；用单一 owner、errgroup/context 收口。
- 共享 map 靠“低并发没事”：必须同步、串行所有权或 `sync.Map`，并跑 race。
- `fmt.Errorf("x: %v", err)`：丢失错误链，应用 `%w`、`errors.Is/As`，多错误补 `errors.Join` 测试。
- repo 返回 nil 表示 not found：调用方无法区分不存在、无权限、DB 错误和空结果。
- 事务里调用外部 HTTP/发消息：锁时间不可控，失败后无法一致回滚；改为 outbox 或提交后发送并补偿。
- 幂等只靠前端防重复点击：重试、超时、消息重复仍会重复扣减或重复创建，后端必须有幂等设计。
- GORM preload 当权限过滤：preload 只加载关联，不代表对象授权。
- 批量 Update/Delete 不看 WHERE/RowsAffected：可能误更新或静默无效。
- `Updates(struct)` 以为会更新零值：GORM 默认跳过零值，必须显式 Select/map/字段列表。
- 只测 200：没有覆盖 bad request、not found、conflict、permission、timeout 和取消路径。
- 日志打印完整请求体/header：可能泄露 Authorization、cookie、手机号、证件号、密码或内部 key。
- 配置缺失时用空字符串继续启动：线上才暴露连接错库、禁用鉴权或发往测试环境。
- 本地 go.work + replace 通过就提交：会掩盖 CI 单模块依赖问题。
- 私有模块未配 GOPRIVATE：可能泄漏到公共 proxy/sumdb。
- 手改 `.pb.go`/sqlc/ent/mock：下次生成覆盖且源契约仍错。

## 输出模板

- 结论：做了什么/未做什么，是否需要相邻技能。
- 证据：版本、env、GOMOD/GOWORK、入口、调用方、日志/request_id、profile/race/fuzz/testcontainers/govulncheck/lint 命令与结果。
- 影响面：包、接口、goroutine、channel、DB/GORM、HTTP 路由、CLI/worker、生成产物、发布制品。
- 验证：`go test ./...`、目标包测试、`go test -race ./...`、fuzz、benchmark、httptest、testcontainers、govulncheck、golangci-lint/gosec/SARIF；未跑写原因。
- 风险与下一步：残余风险、回滚点、需 api/db/security/obs/release/test/audit 继续收口项。

## 提交前自检

- [ ] 已写清需求到 Go 落地闭环：入口、DTO、domain/service、repo/client、错误映射、测试证据。
- [ ] 已防止 mass assignment；请求 DTO、DB entity、domain model、响应 DTO 没有危险混用。
- [ ] 已处理 JSON unknown fields、body size、零值、PATCH 三态、时间/分页/排序/上传等输入边界。
- [ ] 已确认 Go 版本、toolchain、GOTOOLCHAIN、GOOS/GOARCH、CGO_ENABLED、GOMOD/GOWORK。
- [ ] 已确认 module/workspace、replace/exclude、私有模块 proxy/sumdb 策略。
- [ ] 已搜调用方、接口实现、goroutine 创建点、channel close owner。
- [ ] 已确认 context/timeout 贯穿 handler、service、repo、外部 client；没有无 owner goroutine。
- [ ] 已确认配置必填校验、secret 不落日志、不落错误响应、不落仓库。
- [ ] 涉共享状态已跑 race；涉性能已有 pprof/benchmark baseline；涉复杂输入已评估 fuzz。
- [ ] 涉 Web 已比较 net/http/chi/Gin 路由和 timeout、中间件、错误出口。
- [ ] 涉 DB/GORM 已看 pool、事务、RowsAffected、ErrRecordNotFound、慢查询。
- [ ] 涉 CLI/worker 已验证 signal、shutdown、retry/backoff、ack/offset、幂等。
- [ ] 涉供应链已跑或说明 govulncheck、go mod verify、golangci-lint/gosec/SARIF。
- [ ] 涉发布已记录 CGO/static binary、GoReleaser、SBOM/OpenVEX、`go version -m` 证据。
- [ ] 已按边界交接 tst 和 aud；纯只读说明任务除外。