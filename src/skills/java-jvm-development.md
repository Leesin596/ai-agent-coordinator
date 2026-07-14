---
name: java-jvm-development
description: Java/JVM 实战排障技能 - JDK 17/21/22/23、Maven/Gradle toolchain、BOM/lock/SBOM/reproducible build、Spring Boot 3.x/Jakarta/Security/WebFlux、架构与设计模式边界、JPA/Hibernate 6/MyBatis/事务/HikariCP、resilience4j timeout/retry/circuit breaker、并发/virtual threads/StructuredTaskScope、JVM/GC logs/JFR、Micrometer/OpenTelemetry 高基数治理、GraalVM native image/AOT/CRaC、Checkstyle/ErrorProne/SpotBugs/coverage、JUnit/Mockito/Testcontainers/ArchUnit/契约/并发测试。当涉及 Java/JVM 代码、pom.xml、build.gradle、Spring、ORM、并发、JVM 性能或 Java 构建依赖排障时必须使用。
---
# Java/JVM 开发

Java/JVM 开发（java-jvm-development，兼容 slug: jv）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

定位：只处理 Java/JVM 独有现场：JDK 字节码、构建供应链、Spring/Jakarta、ORM/事务、线程模型、JVM 运行时、容器内存、native image、架构边界、质量门禁和 Java 测试矩阵。先拿版本与证据，再按场景卡最小修改；不把通用后端模板伪装成 Java 结论。

## 快速总则

- 版本先行：确认 `java -version`、`javac -version`、wrapper、Maven/Gradle toolchain、`--release`、Spring Boot 3.x、Hibernate 6、Jakarta EE、CI JDK、容器 JRE、GraalVM/native-image 版本。
- 边界先行：改 public API、DTO、Entity、枚举、模块、包依赖、Bean、配置、数据库映射、外部客户端前，先搜生产方、消费方、测试、迁移、CI、Docker 和运行参数。
- 线程先行：区分 MVC、WebFlux、batch、scheduler、consumer、virtual threads、platform threads、ForkJoinPool、StructuredTaskScope、Reactor Scheduler、线程池和下游连接池。
- 运行时先行：确认 JVM flags、GC logs、JFR、heap/thread dump、container memory、CPU quota、HikariCP、Micrometer/OpenTelemetry、镜像 base JDK。
- 门禁先行：新增或核心改动必须说明 Checkstyle、ErrorProne、SpotBugs、coverage、JUnit/Mockito/Testcontainers/ArchUnit/contract/concurrency test 的取舍；未跑标未验证。
- 供应链先行：新增/升级依赖必须说明来源、scope、BOM、lock、校验、许可证、CVE 可达性、SBOM、shaded jar、reproducible build 和回滚版本。
- 证据先行：构建错误要有命令和依赖树；运行错误要有异常全文、profile、配置来源、traceId；性能问题要有 JFR/GC/指标/SQL；未跑不报完成。

## 单技能工程门禁

- 需求落地先画 Java 闭环：Controller/API DTO、validation group、Service 事务边界、Domain/Entity、Repository/Mapper、外部客户端、配置、日志、测试和构建产物必须逐项对应；缺一项就标风险，不用“框架会处理”带过。
- DTO/Entity 门禁：创建、更新、PATCH、响应、事件消息和持久化 Entity 必须按用途分离；BeanUtils、ModelMapper、MapStruct 默认全量映射都要白名单字段、方向和三态语义，禁止把内部字段、租户字段、乐观锁字段和懒加载关系自动拷贝。
- Validation 门禁：Bean Validation 要区分 Create/Update/Patch/Query groups；嵌套对象、集合元素、枚举、金额、时间范围和跨字段校验要有负例；Controller 校验不能代替 Service/domain invariant。
- 事务门禁：`@Transactional` 只包数据库一致性边界，禁止包 HTTP、MQ、文件、支付、邮件等外部 IO；跨服务副作用用 outbox、afterCommit、补偿或幂等任务表达。
- ORM 门禁：JPA dirty checking、flush 时机、lazy 关系、cascade、orphanRemoval、批量 update/delete、MyBatis 动态 SQL 都要有 SQL/RowsAffected/tenant/version 证据；禁止小数据样本替代 N+1 和并发验证。
- 异步门禁：CompletableFuture、Executor、Scheduler、virtual threads、ThreadLocal、MDC、SecurityContext 必须写清生命周期、超时、取消、异常传播、上下文清理和 shutdown；禁止使用 commonPool 承载阻塞业务。
- HTTP 客户端门禁：WebClient、Feign、RestTemplate、OkHttp、gRPC 必须有 connect/read/response timeout、连接池、有限重试、幂等判定、trace 传播和下游错误映射；非幂等写请求默认不自动重试。
- ObjectMapper 门禁：请求反序列化必须决定 unknown fields 策略、枚举未知值、时间/时区、BigDecimal 精度、多态白名单和错误码；禁止默认吞字段后仍返回成功。
- 配置与 secret 门禁：`@Value`、ConfigurationProperties、profile、配置中心、环境变量和默认值必须 fail-fast；secret、token、cookie、连接串、证书和请求体全文禁止进入日志、异常、metrics tag 或测试快照。
- 验收门禁：最少给出 compile/test 命令；涉及 DB/事务/SQL 用 Testcontainers 或真实 DB；涉及公开接口用 contract/integration；涉及构建依赖用 Maven/Gradle wrapper、toolchain、lock 或 verification metadata；不能跑时写明缺口。

## 目录建议

- `jdk-build`：JDK/toolchain、Maven、Gradle、依赖树、BOM、lock、SBOM、reproducible build、JPMS、annotation processors。
- `architecture-patterns`：模块边界、包依赖方向、DDD/hexagonal/layered、设计模式适用边界、ArchUnit、public API 兼容。
- `spring-web`：Spring Boot 3.x、Jakarta、MVC/WebFlux、Security、DTO/Jackson、Bean 装配、AOT/native hints。
- `data-transaction`：JPA/Hibernate 6、MyBatis、SQL、事务传播、HikariCP、缓存调用层和一致性。
- `async-resilience`：Executor、virtual threads、StructuredTaskScope、Reactor、消息/批处理、resilience4j、timeout/retry/circuit breaker。
- `observability-runtime`：JFR、GC logs、thread/heap dump、Micrometer/OpenTelemetry、MDC/trace、container memory、GraalVM native image/CRaC。
- `quality-gates`：Checkstyle、ErrorProne、SpotBugs、Nullness、coverage、mutation、CI 失败门禁和误报处置。
- `test-matrix`：JUnit 5、Mockito、Testcontainers、ArchUnit、contract tests、concurrency tests、security/transaction/native smoke。
- `supply-chain-release`：Maven/Gradle 发布、artifact 签名、SBOM、dependency lock、镜像、health check、灰度回滚。

## 场景执行卡

### 1. JDK / Maven / Gradle / 供应链
- 输入：JDK 版本、wrapper、构建命令、POM/Gradle、dependency tree、toolchain、annotation processors、CI 日志、仓库来源。
- 动作：核对 `source/target/release`、Maven/Gradle toolchain、BOM 与显式版本、dependency lock、plugin 版本、JPMS classpath/module path、Lombok/MapStruct、shaded jar、私服优先级、SBOM 和 reproducible build。
- 证据：版本输出、冲突路径、lock diff、SBOM/扫描结果、失败命令退出码、CI 与本地差异。
- 停止条件：依赖树、运行 JDK 或仓库来源不明时，先不改业务代码。

### 2. 架构 / 设计模式 / 语言 API
- 输入：目标 JDK、模块结构、包依赖、公共 API、DTO/Entity、records/sealed/pattern matching/switch expression、设计模式诉求。
- 动作：先判边界再选模式；Controller 只编排，Domain 不依赖 Infrastructure；Adapter/Strategy/Factory/Template/Observer 只在变化点明确时使用；避免为模式造抽象。查不可变性、Optional/Stream/parallelStream、java.time、循环依赖、跨层调用和序列化兼容。
- 证据：引用搜索、ArchUnit/模块测试、消费者影响、兼容测试、模式替换收益与非目标。
- 停止条件：未查下游引用和模块依赖时，不改 public API、枚举、DTO 字段、包边界或抽象层。

### 3. Spring Boot 3.x / Jakarta / MVC / WebFlux / Security
- 输入：Boot/Spring/Security 版本、active profiles、配置来源、启动日志、ConditionEvaluationReport、filter chain、路由和失败请求样本。
- 动作：查 `javax.*`/`jakarta.*` 混用、ConfigurationProperties、Conditional、Bean 冲突、扫描路径、SecurityFilterChain/SecurityWebFilterChain、matcher 顺序、method security、CORS/CSRF、AOT/native hints。
- 证据：实际 profile、属性来源、命中的 chain、401/403/越权测试、启动失败栈。
- 停止条件：配置中心或部署变量不可见时，结论标需环境验证；未测未登录/无权限/他人资源，不报鉴权完成。

### 4. REST / DTO / Jackson / records / sealed classes
- 输入：接口契约、请求响应样本、ObjectMapper、DTO/Entity、调用方兼容要求。
- 动作：Entity 不直接外露；records/sealed classes 要核 Jackson 模块、构造器、默认值、枚举扩展、unknown fields、OpenAPI schema 和向后兼容；多态反序列化必须白名单。
- 证据：序列化/反序列化测试、unknown fields/类型错误/枚举未知值样本、旧字段兼容、错误响应样本、contract test。
- 停止条件：未查消费方时，不删改公共 JSON 字段。

### 4A. Spring DTO / PATCH / ORM 写保护
- DTO 分层：Spring Controller 输入 DTO、Service command/query DTO、Response DTO、JPA Entity 必须分离；禁止请求体或响应体直绑 JPA Entity，禁止把 Entity 字段、懒加载关系、审计字段、租户字段、软删字段和乐观锁字段原样暴露给 Jackson。
- Jackson 边界：禁止用 Jackson 直接反序列化到 JPA Entity 后 merge/save；`@JsonIgnore`、`@JsonView`、`@JsonManagedReference` 只能缓解序列化症状，不能替代 DTO/Response 分离和显式映射。
- PATCH 语义：部分更新必须区分 absent/null/value；可用 JsonNullable、Optional wrapper、MapStruct presence checker、field mask 或显式 patch command 记录字段是否出现，禁止把 Java 默认值、空字符串或 null 当作“用户没传”。
- MapStruct：PATCH 映射必须开启 presence/condition 规则或显式 ignore absent 字段；null 是清空值还是忽略值要由接口契约写明，禁止全局 `NullValuePropertyMappingStrategy.IGNORE` 掩盖字段清空需求。
- `Optional` 边界：Optional 可表达业务返回缺失，不建议作为 JPA Entity 字段；用于 PATCH wrapper 时必须说明 absent/null/value 三态，禁止在 DTO getter 里返回 null Optional。
- save 边界：Spring Data `save`、JPA `merge`、MyBatis 全量 update 不能当部分更新；先按 id+tenant+version 读取或带条件 update，再按白名单字段赋值，避免丢字段、越权改字段和覆盖并发更新。
- ORM 写保护：JPA/MyBatis 更新/删除必须确认 WHERE 条件包含主键或业务唯一键、tenant/owner 权限条件、version 或等价并发条件；执行后校验影响行数，0 行要映射为 not found、forbidden、conflict 或 already deleted，禁止静默成功。
- 软删：使用 `@Where`、`@SQLDelete`、逻辑删除拦截器或 MyBatis 条件时，要验证读路径、唯一约束、恢复路径、审计字段和错误映射；删除、恢复、更新都要避免跨租户和已删除数据误命中。
- 错误映射：字段校验失败、JSON 类型错误、Entity 不存在、tenant 不匹配、version 冲突、软删已删除、影响行数异常要映射到稳定错误码/状态码；禁止把 ORM 异常栈、SQL 或内部字段直接回显。
- 证据：PATCH contract test、Jackson 反序列化测试、MapStruct 映射测试、JPA/MyBatis SQL log、WHERE 条件截图/日志、影响行数断言、tenant/version/soft delete 回归、旧客户端兼容样本。

### 5. JPA / Hibernate 6 / MyBatis / 事务 / HikariCP
- 输入：Entity 关系、Mapper、实际 SQL、事务入口、隔离/传播、数据库版本、HikariCP 指标、并发路径。
- 动作：查 N+1、LazyInitializationException、fetch join 分页、EntityGraph、DTO 投影、dirty checking、flush、cascade、Hibernate 6 方言/类型变化、MyBatis `${}`、空条件全表、事务自调用、final/private、catch 后提交、连接泄漏、active/idle/pending、幂等键。
- 证据：SQL 数量、explain、事务日志、RowsAffected、optimistic lock 冲突样本、HikariCP metrics、thread dump、DB 锁等待、Testcontainers 或真实 DB 回归。
- 停止条件：无 SQL/事务/连接池证据不宣称 ORM 或一致性已修；写操作未确认 WHERE、影响范围和回滚时不执行。
- 写保护补充：JPA bulk update/delete、QueryDSL、CriteriaUpdate、MyBatis mapper、XML 动态 SQL、LambdaUpdateWrapper 都要证明 WHERE 非空且包含 tenant/owner/version；影响行数必须进入业务判断，不能只记录日志。
- 软删补充：`@Where` 只影响部分 Hibernate 查询，不等于数据库权限；`@SQLDelete` 要和 version、tenant、deleted_at/deleted_by、唯一索引策略、二级缓存失效一起验证，避免已软删行被更新、恢复或重复创建误伤。

### 6. Async / Reactive / resilience4j / 外部调用
- 输入：MVC/WebFlux、Executor/Scheduler、WebClient/Feign/RestTemplate/gRPC、timeout、retry、bulkhead、circuit breaker、连接池、trace。
- 动作：查 event loop blocking、CompletableFuture commonPool、Executor shutdown、Reactor Context/MDC 传播、backpressure、取消、重试风暴、非幂等自动重试、DNS/TLS、下游限流；resilience4j 必须配置 timeout、retry 上限/退避、circuit breaker 阈值、bulkhead 与指标。
- 证据：线程名、JFR/BlockHound、客户端池指标、Executor 队列/拒绝/关闭证据、timeout 配置、traceId、下游错误样本、压测或故障注入。
- 停止条件：未验证超时、取消、重试条件、熔断恢复、连接池和下游容量，不报异步或集成链路闭环。

### 7. 并发 / virtual threads / StructuredTaskScope
- 输入：任务类型、Executor、下游池、ThreadLocal/MDC/SecurityContext、超时/取消、共享状态、容器 CPU/内存。
- 动作：区分 CPU 与 IO；virtual threads 不替代 DB/HTTP 池；用 JFR 查 Loom pinning；StructuredTaskScope 要处理取消、失败传播、deadline、异常聚合和资源关闭。
- 证据：线程 dump、队列长度、pinning 事件、压测、下游池指标、并发测试。
- 停止条件：未覆盖超时、异常、取消、背压、资源释放，不报并发完成。

### 8. JVM / GC logs / JFR / container memory / native image
- 输入：JDK、JVM flags、容器 CPU/内存限制、GC logs、JFR、heap/thread dump、Micrometer/OpenTelemetry 指标、native 配置。
- 动作：先分 CPU、内存、锁、IO、DB、网络；查 GC pause、allocation、class loading、native memory、direct buffer、metaspace、thread stack、container memory、virtual thread pinning；native image 核 reflection/resource/proxy/JNI/serialization/ServiceLoader hints、CRaC restore 后连接重建。
- 证据：JFR 事件、GC pause、heap dominator、线程状态、P95/P99、基线对比、native 构建输出、启动/健康/核心接口冒烟。
- 停止条件：无基线或无同口径对比，不写性能提升；只 native build 成功不算可上线。

### 9. Micrometer / OpenTelemetry / 运行观测
- 输入：metrics/traces/logs、tag 列表、trace 采样、MDC、exemplar、dashboard、告警阈值。
- 动作：治理高基数 tag：禁止 userId/orderId/raw path/exception message 直接做 tag；URI 模板化；限制 label cardinality；trace/log 用属性或事件承载高基数值并脱敏；virtual threads/Reactor 上下文传播要实测。
- 证据：基数统计、采样策略、traceId 串联、RED/USE 指标、告警样本、成本或存储变化。
- 停止条件：未证明 tag cardinality、采样和脱敏，不报观测闭环。

### 10. 质量门禁链
- 输入：现有 CI、Checkstyle/Formatter、ErrorProne、SpotBugs、NullAway/Checker、JaCoCo、mutation、baseline、误报策略。
- 动作：按风险启用门禁链：格式/Checkstyle 保一致，ErrorProne 抓 bug pattern，SpotBugs 抓字节码风险，coverage 设 line/branch 与 diff 门槛；核心链路补 mutation 或等价负例；generated 代码排除要有来源。
- 证据：CI 命令、失败项、baseline diff、coverage 报告、误报抑制理由。
- 停止条件：只本地 IDE 绿或只编译通过，不报质量门禁完成。

### 11. 测试矩阵
- 输入：变更类型、失败模式、DB/消息/HTTP/鉴权/并发/native/契约影响面、CI 资源。
- 动作：JUnit 5 覆盖单元与参数化；Mockito 只隔离纯协作；Testcontainers 覆盖方言、事务、约束和迁移；ArchUnit 覆盖分层/依赖方向；contract tests 覆盖公开接口与旧客户端；concurrency tests 覆盖竞态、幂等、超时取消；必要时补 Security filter chain、Jackson、native smoke。
- 证据：命令、退出码、关键断言、失败前红/修后绿、不可跑原因和替代证据。
- 停止条件：只 Mockito 不能证明事务、SQL、Security filter chain、序列化、native image 正确。

### 12. 生态选型表
- Web：Spring MVC 适合阻塞栈与传统 Servlet；WebFlux 适合端到端非阻塞和高并发 IO，禁止混入阻塞 JDBC 还不隔离。
- 数据：JPA 适合聚合映射和事务模型；MyBatis 适合 SQL 可控与复杂查询；jOOQ 适合类型安全 SQL；选择要看团队、方言、迁移和测试成本。
- 并发：platform threads 简单稳定；virtual threads 适合大量阻塞 IO 但受下游池限制；Reactor 适合非阻塞链路但上下文和背压成本高。
- 构建：Maven 稳定约定强；Gradle 灵活性能好但脚本漂移风险高；二者都要 wrapper、toolchain、BOM/lock、SBOM、reproducible build。
- 观测：Micrometer 做指标 facade；OpenTelemetry 做 trace/log/metrics 标准化；高基数和采样策略优先于“全量埋点”。

## 高频坑 / 防遗漏

- JDK：本地 Java 22/23 编译，CI 或容器 Java 21 运行；`--release`、preview flag、toolchain、镜像 JDK 不一致。
- 架构：为设计模式造抽象；Controller/Mapper/Listener 承载核心域逻辑；DTO/Entity 边界混乱；ArchUnit 缺失导致循环依赖回潮。
- 构建：wrapper 漂移；BOM 与显式版本冲突；annotation processor 未进 CI；dependency lock/SBOM 漏 plugin 或 shaded jar；reproducible build 未固定时间戳和文件顺序。
- DTO 映射：BeanUtils/ModelMapper 按同名字段全量复制，把 role、tenantId、deleted、version、balance、ownerId 等不可写字段从请求覆盖进 Entity。
- 校验：只在 Controller 上 `@Valid`，漏 validation groups、嵌套集合元素、跨字段约束和 Service 内部入口，导致定时任务、MQ、批处理绕过校验。
- Spring：Boot 3.x 迁移只改 import，漏 Jakarta、Security 6、Hibernate 6、Jackson、Servlet、AOT/native hints。
- Security：matcher 宽规则前置；method security 缺 `--parameters`；MVC/WebFlux filter chain 混用。
- WebFlux/Reactor：event loop 上跑 JDBC、文件 IO、阻塞 HTTP client 或 `Thread.sleep`；必要阻塞必须隔离到 boundedElastic 并设置超时、并发上限和监控。
- ORM/事务：Hibernate 6 方言/类型/分页变化；N+1 被小数据掩盖；OSIV 掩盖懒加载；事务自调用、受检异常、catch 后提交、异步跨线程。
- 连接池：HikariCP 池调大掩盖泄漏、慢 SQL、下游容量不足；virtual threads 打满有限连接池。
- 外部调用：未显式 timeout/retry/circuit breaker/bulkhead；非幂等 POST 自动重试；resilience4j 指标没接入导致熔断不可观测。
- 缓存：key 漏租户、用户、角色、价格、库存等维度；TTL、空值、事务后失效和序列化兼容缺回归。
- 观测：Micrometer/OTel 高基数 tag 失控；raw URL、userId、orderId、exception message 进 label；MDC 在 Reactor/virtual threads 丢失。
- 安全：Jackson default typing 过宽、SpEL/模板注入、路径遍历、XXE、SSRF、Actuator 暴露、异常回显和日志敏感字段。
- 并发：ThreadLocal/MDC/SecurityContext 在 virtual threads/异步中丢失或泄漏；parallelStream 跑阻塞 IO。
- 异步：CompletableFuture 异常未 join/get，Executor 没有 bounded queue、拒绝策略和 shutdown；请求结束后异步任务继续使用失效 SecurityContext 或事务对象。
- JSON：ObjectMapper 默认忽略未知字段、宽松枚举或时区漂移，客户端传错字段仍成功，排障时才发现数据未生效。
- JVM：GC logs/JFR 缺失；container memory 未识别；OOM 只看 heap 不看 metaspace/direct/native memory/thread stack。
- 发布：native image 漏反射/资源；CRaC restore 后连接未重建；健康检查只看进程；镜像 tag 可变。
- 测试：只 Mockito，不跑真实 DB/Testcontainers；只 happy path，不测权限、事务、并发、契约、旧端和回滚。

## 输出要求

1. 场景卡：说明命中 jdk-build、architecture-patterns、spring-web、data-transaction、async-resilience、observability-runtime、quality-gates、test-matrix、supply-chain-release 中哪些。
2. 现场证据：JDK/构建/框架版本、profile、运行入口、线程模型、依赖树、复现命令、日志/指标；未跑标未验证。
3. 影响面：Controller、DTO、Entity、Service、Repository/Mapper、配置、依赖、缓存、消息、外部客户端、测试、CI、Docker、消费者。
4. 风险点：架构边界、事务、连接池、N+1、鉴权、序列化、并发、profile、依赖冲突、GC/container memory、安全供应链、缓存串权、重试风暴、高基数指标。
5. 改动说明：只列与目标相关的最小改动；不夹带重构、美化或框架替换。
6. 验证结果：命令、退出码、关键输出；无法验证写原因和下一步。
7. 联动技能：API 契约读 api；表/SQL/迁移/缓存结构读 db；观测/SLO 读 obs；发布读 rls；后端入口读 be；安全专项读 wsec/dso；测试读 tst；最终收口读 aud。

## 约束

- 不重复全局触发规则；本技能只给 Java/JVM 证据和执行口径。
- 新项目最低 Java 17，推荐 Java 21 LTS；Java 22/23 默认按非 LTS 风险处理，生产预览特性需显式批准和验证。
- 版本/API/字段不确定必须查项目证据或官方口径；禁止凭记忆硬改。
- 禁止吞异常、空 catch、`System.out.println`、`new Thread()`、裸泛型、返回 null 集合。
- 禁止 `catch Exception` 后返回成功、空列表或默认对象；异常必须按业务语义映射、记录 traceId 并保留可定位证据。
- 禁止字符串/包装类/BigDecimal 用 `==` 做业务比较；金额禁止 double/float。
- 禁止 Controller 承载复杂业务或直接暴露 JPA Entity；禁止为设计模式增加无证据抽象。
- 禁止 Controller 直接返回、接收或透传 Entity、Page<Entity>、懒加载集合和 ORM 代理对象。
- 禁止默认 ObjectMapper 误吞 unknown fields 后当请求成功；策略必须显式并有错误样本或兼容说明。
- 禁止无 WHERE 更新/删除、MyBatis `${}` 拼接用户输入、原生 SQL 拼接。
- 禁止请求 DTO、PATCH DTO、Response DTO 与 JPA Entity 混用；禁止 Jackson 直绑 JPA Entity 做创建、更新、部分更新或响应输出。
- 禁止用 `save`、`merge`、BeanUtils.copyProperties、ModelMapper、MapStruct 默认全量映射当 PATCH；必须显式处理 JsonNullable/Optional wrapper/MapStruct presence/field mask 的 absent/null/value。
- 禁止忽略 JPA/MyBatis 写操作影响行数；禁止缺 tenant、owner、version 或软删条件的更新/删除进入核心链路。
- 禁止把 `@Where`、`@SQLDelete`、逻辑删除插件当完整安全边界；必须验证读写删恢复路径和错误映射。
- 禁止 `@Transactional` 包住外部 HTTP/MQ/文件/支付/邮件调用；事务内副作用必须改成 outbox、afterCommit、幂等任务或补偿链路。
- 禁止用 Stream/parallelStream 掩盖复杂业务或执行阻塞 IO；复杂 Stream 优先拆命名步骤。
- 禁止 CompletableFuture 无超时、无异常归宿、无上下文清理；禁止把阻塞 IO 丢进 commonPool。
- 禁止在 WebFlux event loop 上执行阻塞 IO；必须隔离并证明超时、并发上限和上下文传播。
- 禁止对非幂等外部写请求配置自动重试；重试必须有上限、退避、熔断和可观测证据。
- 禁止缓存包含租户、用户、角色、价格、库存等上下文差异的响应而 key 不含对应维度。
- 禁止新增危险默认配置后 silent fallback；核心配置缺失应 fail-fast 并给出环境验证。
- 禁止开放 XML 外部实体、宽泛反序列化、用户可控 SpEL/模板表达式、未规范化文件路径和未 allowlist 的服务端 URL 请求。
- 禁止把 virtual threads 当性能万能开关；下游池、限流、Loom pinning、container memory 必须验证。
- 禁止只用 mock 证明事务、SQL、Security filter chain、序列化、native image 正确。
- 性能结论必须有 JFR/GC logs/Micrometer/OpenTelemetry/压测/SQL 证据。

## 高频 Bug 反例库

- 反例 1：错法 / 对法 / 根因：`this.save()` 调 `@Transactional` 方法就认为有事务 / 把事务放到外部 Service 边界或走代理并补回滚测试 / Spring 声明式事务依赖代理，内部调用绕过代理链。
- 反例 2：错法 / 对法 / 根因：HikariCP 耗尽只调大 maximumPoolSize / 看 active、idle、pending、leakDetection、thread dump、慢 SQL，再修释放和超时 / 池耗尽常是泄漏、慢查询或并发超配。
- 反例 3：错法 / 对法 / 根因：列表返回 Entity 触发 N+1 但只看小数据 / 用 SQL log 证明查询数，改 DTO 投影、join fetch 或 EntityGraph / ORM 懒加载与序列化会放大查询。
- 反例 4：错法 / 对法 / 根因：用 OSIV 或扩大 Controller 事务掩盖 LazyInitializationException / Service 内完成抓取和 DTO 映射 / 持久化上下文关闭后访问懒加载属性。
- 反例 5：错法 / 对法 / 根因：开启 virtual threads 后不管 DB/HTTP 池和限流 / 按下游容量、超时、pinning、JFR 和压测调参 / 虚拟线程降低线程成本，不扩大外部资源容量。
- 反例 6：错法 / 对法 / 根因：Security `permitAll` 宽 matcher 放前导致敏感接口漏保护 / 从具体到宽泛排序并测 401、403、越权 / Security matcher 首个命中决定结果。
- 反例 7：错法 / 对法 / 根因：本地 dev profile 正常就宣称配置修好 / 列 active profiles、属性来源并验证 test/staging/prod 关键配置 / Spring 配置优先级和 profile 组合会改变行为。
- 反例 8：错法 / 对法 / 根因：对外输入开放 Jackson default typing 或过宽 subtype / 禁默认开放多态，使用白名单 DTO 和显式 subtype / 多态反序列化可能形成 RCE 或数据破坏链。
- 反例 9：错法 / 对法 / 根因：异常日志打印 Authorization、Cookie、身份证、密码、请求体全文 / 结构化日志只留 traceId、业务 id 和脱敏字段 / 日志是权限更弱、留存更久的数据出口。
- 反例 10：错法 / 对法 / 根因：Repository、事务、SQL 全 mock 后说已覆盖 / 核心 SQL、事务、迁移和序列化用 Testcontainers 或等价真实环境 / Mock 不能证明数据库方言、约束和事务行为。
- 反例 11：错法 / 对法 / 根因：Feign/WebClient 对 POST 自动无限重试 / 只对幂等操作有限退避重试并加熔断、超时和 trace / 重试会放大下游故障并造成重复写。
- 反例 12：错法 / 对法 / 根因：加 Strategy/Factory 后说架构更好 / 先用 ArchUnit 和变化点证明边界，简单分支保留显式代码 / 模式服务于稳定变化点，不服务于形式感。
- 反例 13：错法 / 对法 / 根因：只加 JaCoCo 行覆盖就放行 / 同时看分支、关键断言、变更 diff、mutation 或负例 / 覆盖率不能证明断言有效。
- 反例 14：错法 / 对法 / 根因：SBOM 只扫应用 jar 不扫 shaded/plugin/runtime image / 覆盖依赖、插件、镜像层和许可证 / 供应链风险常在构建插件和打包产物里。
- 反例 15：错法 / 对法 / 根因：Controller 接收 JPA Entity 并让 Jackson 反序列化后 `save` / 使用 CreateDto、PatchDto、ResponseDto 与 Entity 分离，Service 内显式映射白名单字段 / Entity 直绑会暴露内部字段、触发懒加载、绕过权限和覆盖不可改字段。
- 反例 16：错法 / 对法 / 根因：PATCH DTO 字段为 null 就跳过更新 / 用 JsonNullable、Optional wrapper、MapStruct presence 或 field mask 区分 absent/null/value 并写 contract test / PATCH 三态不清会让“清空字段”和“未传字段”互相误伤。
- 反例 17：错法 / 对法 / 根因：Spring Data `save` 或 MyBatis 全量 update 当部分更新 / 先查 tenant+id+version 或执行带条件 update，只改允许字段并断言影响行数 / 全量保存会丢失并发修改、覆盖默认值和越权字段。
- 反例 18：错法 / 对法 / 根因：JPA/MyBatis 更新只按 id，0 行也返回成功 / WHERE 加 tenant/owner/version/deleted 条件，影响行数 0 映射 not found、forbidden、conflict 或 already deleted / 写入结果是权限、并发和软删状态的证据。
- 反例 19：错法 / 对法 / 根因：加 `@Where` 和 `@SQLDelete` 后认为软删闭环 / 验证普通查询、关联查询、bulk update/delete、唯一约束、恢复、缓存和错误映射 / ORM 软删注解不是数据库级隔离，容易漏掉写路径。
- 反例 20：错法 / 对法 / 根因：BeanUtils 把请求 DTO 同名字段全量复制进 Entity / 用显式 mapper 白名单区分 create/update/patch/response 字段 / 自动映射会覆盖租户、角色、乐观锁、软删和只读字段。
- 反例 21：错法 / 对法 / 根因：validation 只写一套默认 group / 按 Create、Update、Patch、Query、内部 command 分组并补负例 / 不同入口的必填、可空和跨字段规则不同。
- 反例 22：错法 / 对法 / 根因：事务里调用支付、HTTP、MQ 或文件上传 / 数据库事务只包本地一致性，外部副作用走 outbox、afterCommit、幂等和补偿 / 外部 IO 不受数据库回滚控制，还会拉长锁时间。
- 反例 23：错法 / 对法 / 根因：catch Exception 后返回成功响应 / 映射稳定错误码、记录 traceId、保留根异常并补失败断言 / 吞异常会制造假成功和数据不一致。
- 反例 24：错法 / 对法 / 根因：ObjectMapper 忽略未知字段导致 typo 请求成功 / 明确 unknown fields 策略并给 contract test；严格接口返回 4xx，兼容接口写降级说明 / 静默吞字段让客户端和服务端契约漂移。
- 反例 25：错法 / 对法 / 根因：CompletableFuture 异步任务不设置 timeout、executor 和异常处理 / 使用受控 Executor、deadline、exceptionally/handle、取消和 shutdown 证据 / 默认 commonPool 与未归宿异常会让问题延迟爆炸。
- 反例 26：错法 / 对法 / 根因：更新接口只看 save 不看 RowsAffected 或 version / 带 tenant+id+version 条件更新并将 0 行映射为 not found、forbidden 或 conflict / 写入影响行数是权限和并发结果。
- 反例 27：错法 / 对法 / 根因：Maven/Gradle 本地能跑就升级依赖 / 固定 wrapper、toolchain、BOM/lock/verification metadata 并跑 CI 同 JDK / 构建漂移会让本地绿、CI 或容器红。

## 2024-2026 新坑速查

- Java 21：virtual threads 正式可用，但 ThreadLocal、MDC、SecurityContext、synchronized pinning、阻塞驱动和下游池仍要用 JFR/压测验证。
- Java 22/23：非 LTS 与 preview/API 漂移高发；必须核 `--release`、toolchain、CI、容器 JDK、preview 编译和运行参数。
- StructuredTaskScope：仍需按目标 JDK 状态核对预览/孵化/稳定级别；生产启用要写取消、失败传播、deadline 和降级策略。
- Spring Boot 3.x：Java 17+、Jakarta EE namespace、Security 6、Hibernate 6、AOT/native hints、Actuator 端点暴露都要一起核。
- Maven/Gradle：toolchain、BOM、dependency lock、verification metadata、SBOM、plugin 依赖、shaded jar 和 reproducible build 必查。
- Jackson/Spring Boot：默认配置可能随 Boot 版本、starter 和自定义 ObjectMapper 改变；unknown fields、JavaTime、BigDecimal、enum、record 构造器要用请求样本锁住。
- JPA/Hibernate：dirty checking、flush mode、bulk update/delete 绕过 Entity lifecycle；乐观锁、审计字段、二级缓存和事件监听不能靠 save 结果猜。
- Java async：CompletableFuture、virtual threads、Reactor 混用时，MDC/SecurityContext/Locale/Transaction 不会自动可靠传播；要实测上下文和清理。
- Quality gates：Checkstyle、ErrorProne、SpotBugs、coverage、ArchUnit、contract/concurrency tests 要区分强制失败、baseline 和临时豁免期限。
- Micrometer/OpenTelemetry：高基数 tag、trace 采样、MDC 传播、virtual threads 上下文、exemplar 互跳要治理，否则成本和证据都失控。
- GraalVM native image：反射、资源、动态代理、JNI、序列化、日志、ServiceLoader 都可能运行时缺失；构建成功不代表可用。
- CRaC：restore 后外部连接、线程池、随机数、token、时间缓存要重建或刷新；健康检查必须覆盖恢复路径。
- Testcontainers：CI Docker 权限、ARM/AMD、镜像缓存、Ryuk、网络策略、健康检查会让本地绿 CI 红。

## 与相邻技能的边界

- Java/JVM 开发/java-jvm-development（jv） 负责：Java/JVM 语言、JDK/toolchain、Spring/Servlet/WebFlux、ORM 映射、事务代理、HikariCP、序列化、线程模型、Reactive 实现、消息/批处理 Java 入口、Spring Cache 调用层、JVM/GC/JFR、GraalVM/AOT、Java 构建依赖、质量门禁和测试实现口径。
- API 工程/api-engineering（api） 负责：HTTP/API 契约、状态码、错误结构、版本兼容、OpenAPI、认证授权语义、幂等契约和消费者迁移。
- 数据库工程/database-engineering（db） 负责：表结构、字段、索引、SQL 设计、迁移、锁、数据修复、Redis/缓存一致性；Java/JVM 开发/java-jvm-development（jv） 只处理 ORM/事务/缓存调用层证据。
- 可观测性/observability（obs） 负责：SLI/SLO/Error Budget、告警、dashboard、incident、OpenTelemetry 治理和生产证据链；Java/JVM 开发/java-jvm-development（jv） 只解释 JVM/应用侧信号。
- 发布部署/release-engineering（rls） 负责：CI/CD、artifact、SBOM、签名、灰度、健康检查、回滚和发布审计；Java/JVM 开发/java-jvm-development（jv） 只给 Java 构建和运行时风险。
- 后端工程/backend-engineering（be） 负责：后端入口、配置、服务分层、依赖交互、限流熔断、部署运行事实；Java/JVM 开发/java-jvm-development（jv） 聚焦 Java 实现与 JVM 现场。
- Web 安全/web-security（wsec）/DevSecOps/devsecops（dso） 负责：安全专项威胁建模、SAST/DAST、供应链策略、漏洞处置和合规；Java/JVM 开发/java-jvm-development（jv） 只列 Java 生态常见输入与依赖证据。
- 测试验证/test-engineering（tst） 负责：场景矩阵、Mock 边界、CI 测试证据、回归充分性；Java/JVM 开发/java-jvm-development（jv） 只说明 Java 测试工具和要验证的失败模式。
- 代码审计/code-audit（aud） 负责：最终需求对账、影响面、安全质量和证据边界；Java/JVM 开发/java-jvm-development（jv） 不替代审计结论。

## 提交前自检清单

- [ ] 行数 < 500。
- [ ] name 为 `Java/JVM 开发/java-jvm-development（jv）`。
- [ ] P0 覆盖：架构/设计模式边界；Checkstyle+ErrorProne+SpotBugs+coverage；JUnit/Mockito/Testcontainers/ArchUnit/契约/并发；Maven/Gradle toolchain、BOM、lock、SBOM、reproducible build。
- [ ] P0 覆盖：Spring DTO/Entity/Response 分离、Jackson 禁直绑 JPA Entity、PATCH absent/null/value、MapStruct presence/field mask、JPA/MyBatis WHERE/tenant/version/影响行数、`@Where`/`@SQLDelete` 软删与错误映射。
- [ ] P1 覆盖：resilience4j timeout/retry/circuit breaker；Micrometer/OTel 高基数治理；生态选型表。
- [ ] 保留 JVM/Spring/ORM/并发/JFR/GC/native image 排障优势。