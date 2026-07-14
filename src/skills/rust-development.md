---
name: rust-development
description: Rust Dev实战排障版 - 覆盖 Rust 2024 edition、Cargo resolver/workspace/features、ownership/borrow/lifetime、trait/generic、async tokio/axum、Rust Web 后端、unsafe/FFI、serde/sqlx、WASM、embedded/no_std、cross compile、musl/glibc、clippy/miri/loom/fuzz、cargo-audit/cargo-deny/cargo-vet 供应链、Actix Web 生产卡和 Tauri Rust 边界。涉及 .rs、Cargo.toml、Cargo.lock、build.rs、Rust 测试、Rust 后端/CLI/FFI/WASM/嵌入式/桌面核心实现时必须使用。
---

# Rust 开发

Rust 开发（rust-development，兼容 slug: rs）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

> 定位：把 Rust 改动从“能编译”收敛到“类型边界清楚、所有权设计正确、异步并发可控、unsafe 有契约、Cargo/target/供应链可验证”。
> 铁律：先定 rustc/Cargo/edition/target/workspace，再搜调用方和 feature 消费方，最后用命令证据收口；未读不引、未跑不报。

## 快速总则

1. 版本先定：记录 rustc -Vv、cargo -V、edition、rust-toolchain、rust-version/MSRV、target、OS/arch；Rust 2024 edition、Rust 1.75/1.80/1.85+ 行为变化必须点名影响。
2. Workspace 先看全局：Cargo.toml、Cargo.lock、resolver、members、default-members、patch/replace、workspace.dependencies、target cfg、build.rs 一起读；单 crate 绿不代表 workspace 绿。
3. Feature 先画传播：Cargo feature 是统一后的编译契约；改 default feature、optional dependency、cfg(feature)、resolver v2/v3 前必须看 cargo tree 与下游 target。
4. 类型边界先设计：ownership、borrow、lifetime、trait、generic、dyn、Pin、Send、Sync 是语义，不是为过编译而堆 clone、Arc<Mutex<_>>、Box<dyn Trait>。
5. async 先排阻塞和取消：tokio runtime 位置、锁范围、spawn Send、LocalSet、timeout、select 取消安全、JoinHandle、channel 背压必须成套检查。
6. unsafe/FFI 先缩边界：每个 unsafe block 写 SAFETY，不变量覆盖 aliasing、初始化、layout、ABI、panic、线程、分配释放、编码和生命周期。
7. 数据边界先拿样本：serde/json/toml/yaml、sqlx row 映射、NULL/Option、时间、大整数、浮点、untagged enum、旧数据兼容必须用 fixture 或真实样本验证。
8. Web/安全先限输入：请求体、路径、URL、反序列化、CORS/cookie/session、JWT/OAuth、secret、随机数、constant-time 比较按威胁建模收口。
9. 构建目标先分平台：cross compile、musl/glibc、OpenSSL/ring/sqlite、WASM、no_std、Tauri bundle、证书/时区/动态库常在运行期爆，不用“编译过”替代平台通过。
10. 工具链按风险选：rustfmt、clippy、cargo test 默认；unsafe 补 miri；并发补 loom；解析器/反序列化补 fuzz；性能补 criterion/profile；供应链补 cargo-audit/cargo-deny/cargo-vet。Clippy 分级：correctness=deny，suspicious/style/complexity/perf=warn，pedantic/restriction/nursery 默认 allow，restriction 不整体启用。
11. 结论只覆盖证据：编译通过不等于行为正确，测试通过不等于无竞态，cargo audit 通过不等于 license/source 安全，Tauri 能构建不等于权限和 bundle 正确。

## 单技能工程门禁

- 开发前先定闭环：入口、DTO、domain、entity/row、repo、service、错误类型、日志字段、配置来源、测试入口和验收命令必须能互相对应；缺任一环节时只列缺口，不说“已完成”。
- DTO/domain/entity 分离：serde DTO 只表示外部契约，domain 表达业务不变量，DB row/entity 表达持久化形态；不要让一个 struct 同时承担请求、业务和数据库写入。
- serde 三态门禁：新增字段、PATCH、配置和兼容旧数据时必须区分 absent、null、value；Option<T> 不是 PATCH 三态，必要时用 Option<Option<T>>、专用 tri-state enum、field mask 或显式 command。
- 错误边界门禁：库层优先 thiserror 暴露稳定枚举和 source，应用入口可用 anyhow/eyre 加上下文；Result 不得吞掉或只 log 后继续，用户错误、内部错误、依赖错误和取消超时要有不同分支。
- async 生命周期门禁：每个 spawn 都要有 JoinHandle/JoinSet/TaskTracker 或明确 detach 证据；取消信号、drop 顺序、timeout、backpressure 和 shutdown deadline 要连到入口。
- 共享状态门禁：Arc<Mutex<_>>、RwLock、DashMap、channel、OnceLock/LazyLock 必须说明所有权、锁范围、await 前释放、毒化/关闭策略和测试隔离；不能把锁当全局状态收纳箱。
- 数据库写入门禁：sqlx/Diesel/SeaORM 写操作必须说明 transaction、字段白名单、rows_affected、约束错误映射、乐观锁/状态条件和连接池超时；0 行不是默认成功。
- unsafe/FFI 门禁：unsafe 只留最小块，safe wrapper 在外；SAFETY 必须覆盖指针、长度、对齐、初始化、aliasing、生命周期、线程、panic、分配释放和 ABI。
- 配置与 secret 门禁：配置 schema、默认值、环境变量、feature cfg、日志脱敏和 Debug/Display 行为一起审；token、密码、密钥、连接串和 PII 不进 error chain、tracing span、panic 或测试快照。
- Cargo 交付门禁：cargo features/resolver/lock、MSRV、target matrix、build.rs、git/path dependency、audit/deny/vet 例外和到期时间必须能解释；不靠本机单 crate 通过下结论。
- 验收证据门禁：默认给出 rustfmt、clippy、cargo check/test；涉及 unsafe 补 miri，涉及并发补 loom，涉及 parser/serde 补 fuzz/属性测试，涉及供应链补 cargo audit/deny/vet；未跑必须写原因。

## 硬禁止与低级错拦截

- 禁止在生产可恢复路径新增 unwrap、expect、panic、todo、unimplemented；测试、编译期常量或明确不可达路径也要写理由。
- 禁止 spawn 后不 await、不 abort、不记录 JoinHandle；真正 fire-and-forget 必须有生命周期 owner、错误日志、取消路径和容量上限。
- 禁止在 async runtime 内做阻塞 sleep、阻塞文件/网络、长 CPU 循环、std::sync::Mutex 持锁 await 或嵌套 runtime。
- 禁止把 Option<T> 当 PATCH 三态；禁止用 serde default、flatten、skip_serializing_if、derive Default 掩盖 absent/null/value。
- 禁止请求 DTO 直接派生 Insertable、AsChangeset、ActiveModel 或作为 sqlx 动态写入来源；写库必须显式字段白名单。
- 禁止 UPDATE/DELETE/RESTORE 不看 rows_affected；禁止把 0 行、权限过滤未命中、乐观锁冲突、已删除记录和不存在记录混成成功。
- 禁止吞 Result：不能 let _ =、ok()、unwrap_or_default、map_err 后丢 source，除非记录业务上可丢弃的理由和指标。
- 禁止手动 unsafe impl Send/Sync、裸指针解引用、from_raw_parts、transmute、MaybeUninit assume_init、CString/CStr 边界无不变量说明。
- 禁止 Arc<Mutex<_>> 包住大对象后跨 await、跨外部 I/O 或跨回调；锁内只做最小内存状态变更。
- 禁止日志、panic、Debug、anyhow context、tracing fields、测试 snapshot 输出 secret/token/Authorization/Cookie/连接串/PII。
- 禁止随手开 default features、升级 resolver/MSRV、删除 Cargo.lock 或放宽 audit/deny/vet 规则来让构建变绿。

## 场景执行卡

### 1. 版本、MSRV 与 Rust 2024 edition

- 适用：升级 toolchain、切 edition、CI 与本地不一致、宏/unsafe/lint 行为变化。
- 动作：记录 rustc/Cargo/MSRV；跑 cargo fix --edition 前先建分支和测试基线；检查 unsafe extern、unsafe attributes、static_mut_refs、never type fallback、临时值作用域、macro 兼容。
- 证据：版本输出、失败命令、受影响 crate、edition 迁移 diff、回归命令摘要。
- 兜底：未确认 MSRV 和消费者时，不升级 edition、不改公开 API、不放宽 lint。

### 2. Cargo、resolver、workspace 与 features

- 适用：Cargo.toml/Cargo.lock、workspace 拆分、依赖升级、feature 冲突、target cfg、build.rs。
- 动作：确认 resolver = 2/3；用 cargo metadata/cargo tree 看统一后 feature；检查 default feature 膨胀、dev-dependency 泄露、optional dependency 命名、target-specific deps。
- 证据：cargo tree -e features 摘要、cargo check --workspace、lockfile 变化、MSRV/安全公告。
- 兜底：只在当前 crate 通过，不能下 workspace 兼容结论。

### 3. API、trait、generic 与对象安全

- 适用：新增/修改 pub fn、struct、enum、trait、generic、错误类型、模块边界。
- 动作：先定输入 T/&T/&mut T/&str/&[T] 与返回拥有值/借用值；trait 是否 dyn compatible；泛型约束是否泄露实现细节；枚举新增查 match 默认分支。
- 证据：标识符引用搜索、全部 impl/调用方、编译和示例/文档测试。
- 兜底：调用方和消费方没搜全，不改公共签名。

### 4. ownership、borrow checker 与 lifetime

- 适用：借用冲突、临时值生命周期、self 借用、结构体持引用、clone 泛滥。
- 动作：缩短 borrow 作用域；能拥有就不硬持引用；Cow/Arc/Rc/RefCell/Mutex 只在语义需要时引入；Drop 顺序和闭包捕获单独检查。
- 证据：原始编译错误、改后编译、保留 clone/Arc 的理由和成本。
- 兜底：不要用 'static、clone、Box、unsafe 绕过真实所有权模型。

### 5. Result、Option、panic 与错误模型

- 适用：IO/SQL/网络/配置/CLI/API 错误传播、库层错误类型、用户可见错误。
- 动作：Option 表缺值，Result 表失败；库层暴露稳定错误，应用层加上下文；保留 source；生产可恢复路径不用 unwrap/expect/panic；anyhow/eyre 偏应用层，thiserror 偏库层稳定错误。
- 证据：负向测试、错误输出样本、日志脱敏、错误码/状态码映射、调用方处理分支。
- 兜底：无法确认消费者错误语义时，不把错误压成 String 或统一 500；FFI 边界不能让 panic 跨 ABI 泄露。

### 6. async tokio/axum、Send/Sync、Pin 与并发

- 适用：tokio runtime panic、非 Send future、axum handler trait bound、tower middleware、死锁、任务泄漏、Stream/Pin。
- 动作：定位 runtime 创建点；锁不跨 await；阻塞 IO/CPU 放 spawn_blocking 或专用线程；spawn 前确认 Future: Send；LocalSet 只隔离局部非 Send；select 分支保证取消安全。
- 检查：Mutex/RwLock guard 范围、JoinHandle 收口、timeout、backpressure、tracing span、axum extractor 顺序和 body 消费。
- 证据：panic/trace、tokio::test 配置、loom 或并发回归、任务退出路径。
- 兜底：不在 async fn 内直接 sleep、阻塞文件/网络或长 CPU 循环。

### 7. unsafe、FFI、ABI 与平台库

- 适用：unsafe block、unsafe trait impl、extern C、repr(C)、裸指针、C callback、手动 Send/Sync、bindgen/cbindgen、cxx/autocxx、pyo3/napi-rs。
- 动作：safe wrapper 包外层；检查 null、长度、对齐、初始化、别名、panic 跨 FFI、释放方、线程归属、符号版本和动态库路径；锁定生成工具版本和头文件来源。
- 证据：SAFETY 注释、miri/sanitizer/平台测试、ABI 兼容测试、最小崩溃复现、C/外语侧契约。
- 兜底：写不出不变量就不引入 unsafe；不能为过编译手动 impl Send/Sync。

### 8. serde、sqlx、SQL/IO 与数据兼容

- 适用：JSON/TOML/YAML、配置、sqlx query/query_as、数据库行映射、文件/网络 IO。
- 动作：明确 rename/default/alias/deny_unknown_fields；SQL NULL 对 Option；decimal/time/uuid/json 类型映射；sqlx offline cache 与 DB schema 同步；文件路径做权限和遍历检查。
- 证据：样本输入输出、旧数据 fixture、sqlx prepare/check、负向 IO/SQL 测试。
- 兜底：未见真实样本，不改字段名、默认值、untagged enum 顺序或 SQL nullability。

### 8.1 serde DTO、部分更新与数据库写入保护

- 适用：Rust Web/CLI/Tauri command 中新增或修改 create/update/delete/restore 接口，serde DTO、sqlx/Diesel/SeaORM 写库、PATCH/部分更新、软删和强删。
- 字段契约：serde 请求 DTO、domain model、DB row model、insert/update changeset 必须分层；反序列化结构体只表达外部输入，不得直接当 DB model 或 ORM ActiveModel 全量写入。
- absent/null/value：创建、全量替换、部分更新要先定语义；Option<T> 只能表达 nullable 或缺值中的一种，PATCH 需要区分 absent/null/value 时用 Option<Option<T>>、MaybeUnset/tri-state enum 或 field mask，不允许把未传字段误写成 NULL 或默认值。
- 写入白名单：sqlx 动态 UPDATE、Diesel AsChangeset、SeaORM ActiveModel 只能写允许变更字段；服务端字段、tenant/user/role、created_at、deleted_at、version、余额/库存/状态机字段默认禁止从 DTO 透传。
- 事务与并发：跨表、状态流转、软删/恢复、库存/余额、权限相关写入必须用 transaction；写后检查 rows_affected，0 行要区分 not found、权限过滤未命中、乐观锁 version 冲突或已删除状态。
- 删除契约：默认软删使用 deleted_at，并让查询、唯一约束、恢复 restore、重复删除幂等和审计日志一起设计；force delete 必须单独入口、权限、事务、外键/级联和不可恢复确认，不与普通 delete 混用。
- 错误映射：唯一键、外键、check constraint、not null、序列化/反序列化、数据库超时和死锁要映射为稳定错误码/状态码；日志保留 constraint 名、表/字段和 request id，但不泄露 secret/PII。
- 证据：DTO 与 DB model 的类型定义、字段白名单、SQL/changeset 片段、transaction 边界、rows_affected 分支、deleted_at 查询过滤、restore/force delete 测试和数据库约束错误样本。
- 兜底：未确认 absent/null/value、白名单和 rows_affected 语义时，不合并更新/删除写库逻辑；不把 serde default、skip_serializing_if 或 flatten 当作数据库写入安全边界。

### 9. 性能、内存、二进制体积与发布 target

- 适用：分配过多、clone/collect/to_string、锁竞争、CPU 热点、二进制体积、cross compile、musl/glibc、WASM。
- 动作：先 criterion/profile；区分算法、分配、IO、锁、动态分发、单态化体积；按 target 调 LTO/codegen-units/panic/strip；必要时评估 allocator、rayon/SIMD、cache/false sharing。
- 证据：基线与优化后数据、flamegraph/heap/tokio-console 摘要、目标 target 构建和运行期冒烟、体积预算变化。
- 兜底：无基线不做性能重构；不为微优化引入 unsafe。

### 9.1 Cross build/test target matrix

- 适用：cross.toml、cross build、cross test、musl/glibc、aarch64/armv7、WASM/no_std、CI target matrix。
- 动作：列 host 与目标矩阵：target triple、libc、runner、所需系统库、OpenSSL/ring/sqlite 策略、证书/时区/动态库、是否只 build 或可 test；cross.toml 镜像和 env passthrough 要可追溯。
- Docker/Podman/QEMU 限制：确认容器引擎、权限、volume、network、UID/GID、缓存和镜像 tag；QEMU 只能做兼容冒烟，不能替代真机性能、线程调度、CPU feature、syscall 和 TLS/DNS 运行期验证。
- 证据：cross build --target 与 cross test --target 摘要、matrix 缺口、容器镜像版本、真机/仿真运行期冒烟。
- 兜底：只在 host 或 QEMU 通过，不宣布目标平台生产可用。

### 10. Tauri Rust Core 边界

- 适用：src-tauri 中 Rust command、state、async、serde 类型、Cargo target、sidecar Rust 部分。
- 动作：rs 只处理 Rust 语言、crate、async、serde、error、Cargo 和 target；command/invoke 契约、capabilities/permissions、CSP、bundle/updater 交 taur。
- 证据：Rust command 签名、serde 类型、错误类型、cargo check/test；Tauri 权限和 UI 不在本技能下结论。
- 兜底：不把 Tauri bundle 成功包装成 Rust 逻辑正确，也不把 Rust 编译通过包装成 Tauri 权限安全。

### 11. Rust Web Backend 生产卡

- 适用：axum/tower/hyper/Actix Web 服务、API handler、中间件、连接池、WebSocket/SSE、健康检查。
- 动作：检查 body limit、extractor 拒绝策略、middleware 顺序、超时/重试/限流、连接池生命周期、graceful shutdown、request id/tracing span、WebSocket/SSE 背压。
- Actix Web 生产卡：核 HttpServer::workers 与 CPU/阻塞任务匹配；配置 client_request_timeout 防慢请求；用 shutdown_signal 接 SIGTERM/SIGINT；设置 shutdown_timeout 给连接 drain 截止；用 JsonConfig/PayloadConfig 统一错误映射和 payload limit，避免无限 Json/Bytes/Form 导致内存 DoS。
- 证据：路由和 middleware 注册点、失败响应样本、超时/关闭测试、tracing/request id、压测或并发冒烟；Actix 需给出 workers、client_request_timeout、shutdown_signal、shutdown_timeout、JsonConfig、PayloadConfig/payload limit 注册点。
- 兜底：不把 handler 编译过当作生产后端可靠；服务拓扑、容器、观测和发布交 be/rls。

### 12. Rust Security 卡

- 适用：外部输入、认证会话、文件/命令/URL、反序列化、日志、加密、Web API。
- 动作：限制请求体和递归深度；校验路径遍历/命令注入/SSRF；secret 不 Debug/Display/trace；CORS/cookie/session/JWT/OAuth 边界交 wsec；随机数和 token 比较用安全语义。
- 证据：恶意样本、负向测试、脱敏日志样本、auth/session 配置、依赖安全扫描摘要。
- 兜底：未做威胁建模和负向验证时，不宣布安全；认证授权策略不由 rust-dev 单独下结论。

### 13. Embedded/no_std 卡

- 适用：no_std、alloc、panic handler、HAL/PAC、RTIC/Embassy、中断、flash/EEPROM、交叉编译和板级调试。
- 动作：确认 target triple、linker script、panic/alloc 策略、默认 std 依赖、临界区/中断共享状态、DMA/volatile、体积和功耗预算。
- 证据：目标板或仿真构建、probe/debug 日志、map/size 输出、中断并发测试、flash/EEPROM 读写样本。
- 兜底：host 测试通过不代表板级可用；未见硬件/仿真证据时只列缺口。

### 14. WASM 卡

- 适用：wasm-bindgen/wasm-pack、WASI、wasmtime/wasmer、浏览器/Node、JS 边界类型。
- 动作：明确 ABI/序列化边界、panic hook/log、allocator、feature std/wasm cfg、体积优化、浏览器/Node/运行时兼容。
- 证据：目标 wasm 构建、wasm size、浏览器/Node/wasmtime 冒烟、JS 类型契约和 panic 行为样本。
- 兜底：wasm target 编过不等于 JS/WASI 运行正确。

### 15. Advanced Testing/Fuzzing 卡

- 适用：解析器、serde/nom、状态机、宏、trait 编译期约束、并发、回归矩阵。
- 动作：按风险选 nextest、proptest/quickcheck、cargo-fuzz/libFuzzer、trybuild、insta、mockall/wiremock、coverage、miri、loom；说明各自边界。
- 证据：原 bug 复现、属性测试种子、fuzz corpus/crash、snapshot diff、coverage 摘要、并发模型。
- 兜底：覆盖率和 clippy 不能证明行为正确；fuzz 无 corpus 不下解析安全结论。

### 16. Supply Chain 与可复现构建卡

- 适用：依赖升级、git/path dependency、私有 registry、license/source 策略、SBOM、发布制品。
- 动作：检查 Cargo.lock、checksum、git rev pinning、patch/source、RUSTSEC ignore 到期、cargo-deny/license 例外、cargo-vet、SBOM 和 sparse registry 策略。
- 分工：cargo-audit 查 RustSec/已知漏洞和 yanked crate，重点是 CVE/RUSTSEC ignore 到期；cargo-deny 管 license、ban、source、duplicate、advisory 策略和私有 registry；cargo-vet 记录第三方 crate 审计、trusted publisher/imports 和组织可接受性。三者互补，不能互相替代。
- 证据：cargo-audit/cargo-deny/cargo-vet 摘要、锁文件 diff、来源策略、SBOM/许可证例外审批、CI 门禁。
- 兜底：audit 只覆盖已知漏洞，不能替代 license/source/可复现构建结论。

### 17. 真实开发闭环卡

- 适用：按需求新增 Rust CLI/Web/API/worker/Tauri command/库能力，或从零落地一条业务链路。
- 动作：先列入口、输入 DTO、domain 不变量、错误类型、repo/外部依赖、事务边界、配置、日志字段、测试层和验收命令；再实现最小闭环；最后补负向、并发、取消、兼容和权限/状态边界。
- Rust 侧证据：类型分层、Result 分支、serde 样本、rows_affected 分支、JoinHandle 收口、secret 脱敏样本、Cargo feature/lock diff、rustfmt/clippy/test 输出。
- 兜底：只写 handler/函数、只让编译通过、只测 happy path、只改内存态不跑持久化或取消路径，都不能称为完整开发完成。

## 高频坑 / 防遗漏

### 高频坑

1. 只修 borrow checker，不修所有权模型。
2. lifetime 写成公共 API 负担，导致下游到处传生命周期。
3. trait object 与 generic 混用，忽略 dyn compatibility、对象安全和单态化体积。
4. async 中持锁 await、阻塞 tokio runtime、嵌套 runtime 或漏收 JoinHandle。
5. 非 Send future 在 tokio::spawn 多线程 runtime 才爆，根因常是捕获范围过大。
6. Pin 被当成“禁止移动”魔法，没有投影和 drop 不变量。
7. unsafe 无 SAFETY，FFI 没写分配释放和 panic 边界。
8. serde 字段改名、default 或 deny_unknown_fields 破坏旧数据。
9. sqlx offline cache、DB schema、NULL/Option 不一致，本地编译过线上查询炸。
9.1 请求 DTO 直接派生 Insertable/AsChangeset/ActiveModel 写库，导致越权字段、服务端字段或未传字段被覆盖。
9.2 PATCH 用 Option<T> 混淆 absent 和 null，未传字段被清空，或用户想清空字段却被忽略。
9.3 UPDATE/DELETE 不看 rows_affected，权限过滤、乐观锁冲突、已删除记录和不存在记录被错误报告为成功。
9.4 软删只写 deleted_at，漏掉默认查询过滤、restore、唯一约束冲突和 force delete 权限边界。
10. Cargo default feature 引入平台依赖，workspace 其他 crate 被迫编译失败。
11. resolver v2/v3、target cfg、dev-dependency 误判，本地单 crate 绿 CI 全量红。
12. musl/glibc/OpenSSL/ring/sqlite 只看编译，运行期证书、DNS、动态库才失败。
13. cargo audit 通过就忽略 cargo deny 的 license、ban、source 和 duplicate 风险。
14. Tauri src-tauri 改 Rust command 后未按 taur 核 invoke、permissions、bundle。
15. axum 未设 body limit 或 extractor 拒绝策略，JSON 大包导致内存 DoS 或错误响应失控。
16. graceful shutdown 未收 JoinHandle，部署时丢请求或后台任务泄漏。
17. WebSocket/SSE 未设计背压和断连清理，慢客户端拖垮任务和内存。
18. secret 通过 Debug/anyhow/tracing 链路打进日志，脱敏只做了展示层。
19. SSRF/路径遍历只做字符串前缀判断，未按解析后 URL/path 语义校验。
20. wasm 只编译未跑浏览器/Node/WASI，JS 类型和 panic 行为线上才爆。
21. no_std 引入默认 std 依赖，host 通过但目标板链接失败。
22. 中断共享状态未证明临界区和内存序，偶发竞态只在板上暴露。
23. cargo-fuzz 未覆盖 parser/反序列化边界输入，serde/nom panic 留到生产。
24. git dependency 未 pin rev 或 source policy 不清，构建不可复现。
25. criterion 无基线阈值，性能回归被“测试通过”掩盖。
26. cargo audit 例外无到期时间，RUSTSEC ignore 永久沉默真实风险。
27. 单 struct 多身份：请求 DTO、domain、DB row 共用同一个 struct，后来新增服务端字段被用户输入覆盖。
28. Result 被吞：后台任务或清理逻辑把错误 ok() 掉，调用方看到成功但数据已经半写。
29. thiserror/anyhow 边界反了：库层返回 anyhow::Error，应用层只能字符串匹配；或应用入口暴露内部枚举给用户。
30. async 取消不安全：select 超时后 future drop 了，但事务、临时文件、锁或外部请求没有补偿和清理。
31. JoinHandle 泄漏：spawn 后不收口，panic 被吞，shutdown 时任务继续占连接池。
32. Arc<Mutex> 锁太大：锁内 await 或做外部 I/O，低并发测试绿，线上请求互相卡死。
33. feature 临时放宽：为过 CI 开 default features 或关掉 deny 规则，其他 target 引入 OpenSSL/系统库后发布失败。
34. secret 进错误链：anyhow context 拼了连接串或 Authorization，tracing/error snapshot 把 token 带进日志和测试产物。

### 防遗漏清单

- 改公共 API：pub fn、trait impl、generic bound、enum match、serde、文档示例、测试 fixture 都搜了吗？
- 改所有权：是否说明 ownership/borrow/lifetime 边界，clone/Arc/Mutex 是否有理由？
- 改 async：tokio runtime、锁跨 await、Send/Sync、Pin、取消安全、timeout、JoinHandle、channel/WebSocket/SSE 背压都查了吗？
- 改 Web：body limit、extractor 拒绝、middleware 顺序、连接池、graceful shutdown、request id/tracing、错误映射都覆盖了吗？
- 改 Security：secret 脱敏、路径/命令/SSRF、反序列化 DoS、CORS/cookie/session/JWT/OAuth、crypto/random 是否有证据？
- 改 Cargo：workspace、resolver、feature unification、Cargo.lock、target cfg、build.rs、CI target、git/path deps 都覆盖了吗？
- 改 unsafe/FFI：SAFETY、ABI、layout、panic、线程、分配释放、编码、miri/sanitizer、生成工具版本是否覆盖？
- 改 serde/sqlx/IO：旧样本、NULL/Option、时间/decimal/json、sqlx prepare、错误路径是否验证？
- 改闭环开发：入口、DTO、domain、entity/row、repo、service、错误、配置、日志、测试和验收命令是否成套？
- 改 PATCH/配置：absent/null/value 是否有三类样本，Option<T> 是否被误用为三态？
- 改错误：thiserror/anyhow 边界、source 保留、Result 未吞、用户输出和内部日志是否分开？
- 改共享状态：Arc<Mutex>/RwLock/channel/OnceLock 是否有锁范围、await 前释放、关闭/取消和测试隔离证据？
- 改 cross target：是否列 cross build/test target matrix，覆盖 host、musl/glibc、OpenSSL/ring/sqlite、证书/时区、动态库、WASM/no_std/Tauri 运行期缺口？Docker/Podman/QEMU 限制是否说明？
- 改测试：nextest、proptest、cargo-fuzz、trybuild、insta、coverage、miri/loom 是否按风险选择并记录边界？
- 改供应链：cargo-audit、cargo-deny、cargo-vet、SBOM、license/source、RUSTSEC ignore 到期、checksum/git rev 是否可追溯？
- 收口：rustfmt、clippy、cargo check/test、miri/loom/fuzz/cargo audit/deny/vet 是否按风险选择并记录未跑原因？

## 输出要求

1. 场景卡：列命中版本/edition、Cargo/features、API/trait、ownership/lifetime、error、async/tokio、unsafe/FFI、serde/sqlx、性能/target、Web/Security、WASM、Embedded、Supply Chain、Tauri Rust 边界中的哪几类。
2. 版本证据：列 rustc/Cargo/edition/MSRV/target/workspace；缺失写“无法验证”。
3. 类型边界：输入输出、ownership、borrow、lifetime、trait/generic/dyn、Send/Sync/Pin、错误模型怎么定。
4. 影响面：pub API、workspace、feature、cfg、serde 字段、sqlx/SQL/IO、Web handler/middleware、FFI、WASM/no_std、cross compile、Tauri src-tauri 受影响范围。
5. 工程门禁：DTO/domain/entity 分离、serde absent/null/value、thiserror/anyhow 边界、Result 分支、transaction/rows_affected、JoinHandle、锁范围、secret 脱敏和 Cargo features/lock 如何收口。
6. 风险点：borrow checker、async、runtime、unsafe/FFI、feature unification、serde/sqlx 兼容、Web/security、musl/glibc/WASM/no_std、供应链中的具体风险。
7. 验证命令：列实际跑过的 rustfmt/clippy/cargo check/test/nextest/miri/loom/fuzz/audit/deny/vet/sqlx/cross/wasm/embedded 命令和摘要；未跑写“未验证”。
8. 联动技能与缺口：测试/回归交 tst；最终改动收口交 aud；API/DB/Web 安全/后端/发布/Tauri 只按边界联动，不越界下结论；缺版本、样本、CI、目标平台、并发复现、供应链门禁或第三方契约时必须列出。

## 约束

- 默认遵循项目现有 MSRV、edition、rust-toolchain、Cargo.lock；不擅自升级 Rust 或切 Rust 2024 edition。
- 生产可恢复路径不用 unwrap/expect/panic；错误必须可定位且不泄露 secret/PII/内部路径。
- DTO/domain/entity/response/DB row 不混用；serde 外部契约不能直接成为数据库写入契约。
- PATCH/配置/兼容旧数据必须表达 absent/null/value；Option<T> 不得冒充三态。
- Result 不吞，错误 source 不丢；thiserror/anyhow 边界必须按库层/应用层区分。
- 不用 clone、Arc<Mutex<_>>、Box<dyn Trait>、'static 掩盖设计问题；使用时说明语义和成本。
- async 中不阻塞 runtime，不持锁跨 await，不嵌套 tokio runtime，不丢 JoinHandle。
- unsafe 必须最小化并写 SAFETY；FFI 必须定义内存、ABI、线程、panic 和错误边界。
- 改公共接口、feature、workspace、serde 字段、sqlx 映射、Web handler/middleware、WASM/embedded 边界前必须搜全生产方和消费方。
- 不越权设计外部 API、DB schema、认证授权、发布流程、Tauri 权限/UI；只给 Rust 侧证据和联动边界。
- 无证据不宣布已修复、已兼容、无竞态、可上线或供应链安全。

## 高频 Bug 反例库

- 反例 1：ownership 被 clone 掩盖。错法：借用报错就 clone 整个结构或 String；对法：先缩短 borrow 范围，必要时调整数据归属或返回拥有值；根因：clone 复制状态、放大内存，并隐藏生命周期设计错误。
- 反例 2：lifetime 写成公共负担。错法：为通过编译给 struct/pub fn 加多层 lifetime；对法：判断是否真要持引用；可拥有就拥有，可推断就不手写；根因：生命周期是语义约束，不是安抚编译器的装饰。
- 反例 3：trait object 误用。错法：把含 generic 方法、关联 const 或 Self 返回的 trait 直接 dyn 化；对法：确认 dyn compatibility；需要静态分发保留 generic，需要动态分发拆对象安全接口；根因：trait 抽象同时影响 API、体积和运行时分发。
- 反例 4：tokio runtime 嵌套。错法：在已有 runtime 内 block_on 或新建 runtime；对法：向上传播 async，或把同步边界隔离到明确入口；根因：runtime 嵌套会 panic、死锁或阻塞调度器。
- 反例 5：非 Send future 跨线程 spawn。错法：持 Rc/RefCell/非 Send guard 后 tokio::spawn；对法：用 LocalSet，或改成 Send 类型并在 await 前释放非 Send 借用；根因：多线程调度要求 Future: Send，捕获范围过大会扩大错误。
- 反例 6：axum handler bound 误判。错法：handler 编译不过就乱加 Clone + Send + Sync 或 BoxFuture；对法：检查 extractor 顺序、State 类型、返回 IntoResponse、错误类型和 captured future 是否 Send；根因：axum 的 Handler 约束把 async、trait bound 和 tower 类型一起暴露。
- 反例 7：Pin 当万能固定器。错法：Pin<Box<T>> 后仍移动内部自引用字段；对法：明确 Unpin、投影和 drop 不变量，优先用成熟 crate；根因：Pin 保护移动语义，不自动保证自引用安全。
- 反例 8：unsafe/FFI 缺不变量。错法：extern C 接口直接解引用指针；对法：检查空指针、长度、对齐、生命周期、编码和释放方，并写 SAFETY；根因：FFI 边界编译器无法验证，错误常为生产偶发崩溃。
- 反例 9：手动 Send/Sync 误判。错法：为通过编译 unsafe impl Send/Sync；对法：证明内部跨线程访问、别名、同步和释放安全；无法证明就改设计；根因：Send/Sync 是线程安全契约，不是类型标记补丁。
- 反例 10：Cargo feature 污染 workspace。错法：给 default feature 加重依赖，单 crate 通过就合并；对法：检查 workspace、resolver、cargo tree -e features、下游 cfg 和目标平台；根因：feature unification 会影响所有消费者和目标。
- 反例 11：serde 兼容被破坏。错法：重命名字段、改 default 或加 deny_unknown_fields，未测旧数据；对法：保留 alias/default，拿真实样本做反序列化回归；根因：serde 规则就是外部数据契约。
- 反例 12：sqlx NULL 映射错。错法：数据库列可 NULL，Rust struct 用非 Option，线上遇到旧数据才 panic/报错；对法：用真实 schema 和样本跑 sqlx prepare/check，按 NULL 语义映射 Option；根因：编译期查询校验依赖正确 schema，旧数据和迁移态不可猜。
- 反例 13：SQL/IO 错误被 unwrap。错法：数据库、文件、网络路径 unwrap，线上异常直接 panic；对法：返回 Result，保留源错误和上下文，区分用户可见与内部日志；根因：外部依赖天然可失败，panic 会扩大故障半径。
- 反例 13.1：反序列化 DTO 直写 DB。错法：把 Deserialize 请求结构体直接传给 sqlx/Diesel/SeaORM 写入；对法：DTO 只进校验和显式映射，DB insert/update 使用白名单 changeset；根因：外部输入字段和数据库可写字段不是同一个契约。
- 反例 13.2：部分更新覆盖字段。错法：PATCH DTO 用 Option<T>，序列化缺省后把 absent 写成 NULL；对法：用 Option<Option<T>>、MaybeUnset/tri-state enum 或 field mask 区分 absent/null/value；根因：部分更新必须表达三态，二态类型会丢语义。
- 反例 13.3：删除无状态校验。错法：UPDATE deleted_at 或 DELETE 后直接返回成功；对法：事务内检查 rows_affected、version/deleted_at 条件、restore/force delete 分支和审计；根因：写库成功执行不等于目标状态已按业务达成。
- 反例 14：cross compile 只看编译。错法：musl/WASM/Tauri target 编过就认为可发布；对法：验证运行期证书、DNS、动态库、资源路径、权限、体积和平台 API；根因：目标平台差异主要在运行期暴露。
- 反例 15：cargo audit 替代 cargo deny/vet。错法：audit 没报漏洞就认为依赖安全合规；对法：audit 查 CVE，deny/vet 查 license、ban、source、duplicate、私有 registry 和审计策略；根因：供应链风险不止已知漏洞。
- 反例 16：性能优化无基线。错法：凭感觉把迭代器改循环、引入 unsafe 或全局缓存；对法：先 bench/profile，定位分配、锁、IO、CPU，再做最小优化；根因：无基线会把可读性和性能一起做差。
- 反例 17：Web body limit 缺失。错法：直接 Json<T> 解析无限请求体；对法：设置 body limit、超时和拒绝响应；根因：反序列化和分配会被大包放大成 DoS。
- 反例 18：graceful shutdown 漏任务。错法：只停 listener，不等待 JoinHandle/队列 drain；对法：传播取消、设置 deadline、收口后台任务；根因：部署时请求和任务生命周期不等于进程生命周期。
- 反例 19：secret 日志泄露。错法：Debug 打印 config/error/span；对法：secret 类型不实现明文 Display/Debug，日志脱敏并测样本；根因：错误链和 tracing 会跨层传播敏感值。
- 反例 20：wasm 运行期未验。错法：cargo build --target wasm32 后宣布可用；对法：浏览器/Node/WASI 分别冒烟，验证 JS 类型、panic hook、allocator 和体积；根因：WASM 失败常在宿主边界暴露。
- 反例 21：no_std 被默认 feature 破坏。错法：依赖默认启用 std，host test 通过；对法：target 构建、禁 default features、确认 alloc/panic/linker；根因：嵌入式约束主要在目标链接和运行期暴露。
- 反例 22：fuzz 缺 corpus。错法：解析器只靠单元测试；对法：为边界语法、异常长度、编码和递归准备 corpus/属性测试；根因：输入空间远大于手写样例。
- 反例 23：git dependency 不可复现。错法：依赖 branch 或未审 source；对法：pin rev、记录来源策略、用 lockfile/deny/vet/SBOM 收口；根因：构建输入漂移会绕过审计。
- 反例 24：性能回归无阈值。错法：criterion 跑过但不比基线；对法：保存基线、设预算、同时看 p95/分配/体积；根因：性能是趋势和预算，不是单次通过。
- 反例 25：Result 吞错。错法：后台写库、发送消息或清理文件失败后 let _ = 或 ok()；对法：按可重试、可忽略、必须失败三类处理，保留 source、指标和告警；根因：Rust 类型系统不会替你处理被主动丢弃的错误。
- 反例 26：thiserror/anyhow 边界错。错法：库 crate 暴露 anyhow::Error，API 层字符串匹配错误；对法：库层 thiserror 稳定枚举，应用层 anyhow context，边界处映射状态码/错误码；根因：错误类型也是公共契约。
- 反例 27：JoinHandle 丢失。错法：tokio::spawn 后不保存 handle，panic 和取消都没人管；对法：JoinSet/TaskTracker/handle await，shutdown 传播取消并 drain；根因：任务生命周期不属于 runtime 自动治理。
- 反例 28：Arc<Mutex> 跨 await。错法：锁住共享状态后查库/发请求/await channel；对法：锁内只取最小快照，await 前释放，必要时改 actor/channel；根因：锁范围决定调度和死锁风险。
- 反例 29：unsafe 初始化偷懒。错法：MaybeUninit、from_raw_parts 或 transmute 没证明初始化、长度、对齐和 alias；对法：缩小 unsafe，写 SAFETY，能用安全 API 就不用 unsafe；根因：unsafe 错常表现为偶发内存破坏。
- 反例 30：secret 进日志。错法：derive Debug 的 Config 被 tracing 打印，anyhow context 带 token；对法：secret wrapper 脱敏，日志样本校验，测试 snapshot 过滤；根因：Rust 的 Debug/Error 链会跨层传播。
- 反例 31：Cargo feature 为过构建乱开。错法：给 default features 加 OpenSSL/sqlite/full，当前机器绿；对法：按 target cfg 和 workspace feature tree 验证，必要时拆 feature；根因：feature unification 会把局部便利扩散到全 workspace。
- 反例 32：miri/audit 当万能证明。错法：miri 过就说无 unsafe 问题，audit 过就说供应链安全；对法：miri、sanitizer、loom、fuzz、audit、deny、vet 各按风险覆盖并写边界；根因：工具只能证明它实际覆盖的那部分。

## 提交前自检清单

- [ ] frontmatter name 等于 canonical name（rust-development），旧 slug 只作兼容 alias/URL 主键。
- [ ] 行数 <= 500，且 fenced code block 数为 0。
- [ ] 已确认 Rust/Cargo 版本、edition、MSRV/rust-version、target、workspace 范围；未知项已标无法验证。
- [ ] 已检查 Cargo resolver、feature unification、Cargo.lock、target cfg、build.rs、workspace 消费方、git/path deps。
- [ ] 已检查 ownership、borrow、lifetime、trait/generic/dyn、Send/Sync/Pin 的真实边界。
- [ ] 已检查 DTO/domain/entity/response/DB row 分离，serde DTO 未直接写库，外部契约与持久化契约没有混用。
- [ ] 已检查 absent/null/value 三态、Option<Option<T>>/tri-state/field mask 选择和 PATCH 未传/置空/赋值测试。
- [ ] 已检查 thiserror/anyhow 边界、Result 未吞、source 保留、错误码/状态码映射和日志脱敏。
- [ ] 涉 async/tokio/axum/actix-web/Web 已检查 runtime、锁跨 await、阻塞、取消、timeout、JoinHandle、backpressure、body limit、middleware、Actix workers/client_request_timeout/shutdown_signal/shutdown_timeout/JsonConfig/PayloadConfig/payload limit 和 graceful shutdown。
- [ ] 涉 tokio spawn 已记录 JoinHandle/JoinSet/TaskTracker 收口，或明确 detach owner、错误处理、容量上限和取消路径。
- [ ] 涉 Arc<Mutex>/RwLock/channel/OnceLock/LazyLock 已确认锁范围、await 前释放、关闭策略、测试隔离和外部 I/O 边界。
- [ ] 涉 unsafe/FFI 已写 SAFETY，并按风险考虑 miri/sanitizer/ABI 兼容测试。
- [ ] 涉 serde/sqlx/SQL/IO 已拿样本或 fixture 验证兼容、错误路径和反序列化 DoS 风险。
- [ ] 涉 create/update/patch/delete/restore 写库已分离 serde DTO、domain model、DB row model 和 insert/update changeset，未把反序列化结构体直接写入 DB。
- [ ] 涉部分更新已明确 absent/null/value，按需使用 Option<Option<T>>、MaybeUnset/tri-state enum 或 field mask，并有未传、置空、赋值三类测试。
- [ ] 涉 sqlx/Diesel/SeaORM 写入已使用字段白名单、transaction、rows_affected、乐观锁/version 或状态条件，并映射唯一键/外键/check/not null 等数据库约束错误。
- [ ] 涉删除已区分 soft delete 的 deleted_at、默认查询过滤、restore、幂等重复删除和 force delete 权限/事务/审计边界。
- [ ] 涉 security 已检查 secret、路径/命令/SSRF、CORS/cookie/session/JWT/OAuth/crypto 边界，并列联动缺口。
- [ ] 涉 cross/cross.toml、cross build/test target matrix、musl/glibc、Docker/Podman/QEMU、WASM、no_std/embedded、Tauri Rust Core 已列运行期验证缺口。
- [ ] 已按风险选择 rustfmt、Clippy/clippy.toml 分级、cargo check/test/nextest、miri、loom、fuzz、coverage、cargo-audit/audit.toml、cargo-deny/deny.toml、cargo-vet，并记录未跑原因。
- [ ] 涉测试/回归已联动 tst；代码改动完成前已联动 aud。

## 2024-2026 新坑速查

- Rust 1.75：async fn in trait 稳定后，公共 trait 仍要注意 dyn compatibility、Send 约束和返回 future API 稳定性。
- Rust 1.80：LazyCell/LazyLock 等标准库能力减少依赖，但全局状态仍要审初始化、测试隔离和 Drop 假设。
- Rust 1.85：Rust 2024 edition 进入稳定通道；迁移前必须跑 cargo fix --edition、clippy、宏和 unsafe 边界回归。
- Rust 2024 edition：unsafe extern、unsafe attributes、static_mut_refs、never type fallback、临时值作用域和 match ergonomics 迁移会让旧假设失效。
- Cargo resolver：resolver v2/v3 与 workspace edition、dev-dependency、target-specific dependency 组合影响 feature unification；不要只看当前 crate。
- async 生态：tokio、axum、tower、hyper 版本组合常因 trait bound、Send、Sync、Pin、body/extractor 和 runtime feature 级联报错。
- FFI/unsafe：unsafe_op_in_unsafe_fn 审计口径更严格，unsafe fn 内部也要最小 unsafe block 和 SAFETY 说明。
- serde/sqlx：untagged enum 匹配顺序、flatten、deny_unknown_fields、decimal/time/json/uuid、sqlx offline cache 和迁移态是高频回归点。
- cross compile：列 cross build/test target matrix；musl 静态链接、glibc 版本、OpenSSL、ring、sqlite、DNS/TLS 根证书、时区数据、WASM allocator、Tauri bundle 都要分目标验证；cross 依赖 Docker/Podman 镜像与挂载权限，QEMU 只适合冒烟且可能掩盖性能、线程、CPU feature、syscall 差异。
- supply-chain：cargo-audit 只看已知漏洞/yanked，cargo-deny 管 license、ban、source、duplicate、私有 registry、patch，cargo-vet 管审计记录、trusted imports 和组织接受度，例外必须有到期证据。
- clippy/miri/loom/fuzz：Clippy 分级执行，correctness=deny，suspicious/style/complexity/perf=warn，pedantic/restriction/nursery 默认 allow，restriction 不整体启用；clippy 不是证明正确；miri 不覆盖所有 FFI/并发；loom 需要专门模型；fuzz 需要 corpus 和 oracle，不等于普通测试。
- Web/安全：axum/tower/hyper 的 body limit、extractor 拒绝、graceful shutdown、request id、CORS/cookie/session/JWT/OAuth、SSRF 和 secret 日志必须按场景验证。
- WASM/embedded：WASM 要分浏览器/Node/WASI；embedded/no_std 要查 alloc/panic/linker/HAL/中断/flash/功耗，host 通过不代表目标通过。
- Tauri：src-tauri 的 Rust command/serde/error 属 rust-dev；capabilities/permissions/CSP/plugin/bundle/updater 属 taur，不能混写结论。

## 与相邻技能的边界

- Rust 开发/rust-development（rs） 负责：Rust 语言层、ownership、borrow checker、lifetime、trait、generic、async、tokio、axum、Send、Sync、Pin、unsafe、FFI、serde、sqlx 映射、Cargo、workspace、feature resolver、toolchain、WASM/no_std/embedded Rust 侧和 Rust 验证口径。
- Tauri 桌面应用/tauri-development（taur） 负责：Tauri command/invoke 跨端契约、capabilities/permissions、plugin、CSP、tauri.conf.json、sidecar、bundle、updater、桌面/移动平台排障；Rust 开发/rust-development（rs） 只处理 src-tauri Rust 实现和 Cargo/target 风险。
- 后端工程/backend-engineering（be） 负责：服务入口、路由/中间件生产拓扑、连接池、超时重试、队列缓存、容器运行和观测；Rust 开发/rust-development（rs） 只处理 Rust 实现细节，不替代后端链路结论。
- API 工程/api-engineering（api） 负责：外部 API 契约、认证语义、状态码、幂等和兼容策略；Rust 开发/rust-development（rs） 只处理 Rust 类型、错误和实现边界。
- 数据库工程/database-engineering（db） 负责：schema、迁移、索引、事务、锁和 SQL 设计；Rust 开发/rust-development（rs） 只处理 serde/sqlx/连接/错误传播和 Rust 映射。
- Web 安全/web-security（wsec）/DevSecOps/devsecops（dso） 负责：威胁建模、认证授权策略、SAST/DAST/SBOM/OPA、供应链制度和安全验收；Rust 开发/rust-development（rs） 只列 Rust 实现证据和联动缺口。
- 发布部署/release-engineering（rls） 负责：CI/CD、artifact、SBOM/签名、灰度、回滚、监控和发布证据；Rust 开发/rust-development（rs） 只列 Cargo/target/二进制风险。
- 测试验证/test-engineering（tst） 负责：需求拆条、场景矩阵、原 bug 复现、自动化分层、CI 证据和覆盖结论；Rust 开发/rust-development（rs） 只给 Rust 风险和验证建议。
- 代码审计/code-audit（aud） 负责：最终需求对账、影响面追踪、安全质量复盘、修复复验和上线边界；Rust 开发/rust-development（rs） 不把编译通过包装成审计通过。