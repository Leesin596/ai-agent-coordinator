---
name: python-development
description: Python Dev实战排障版 - 面向 Python 3.11/3.12/3.13/3.14/3.14t、uv/poetry/pip-tools、uv workspace、src-layout/cookiecutter、PEP 668/649、pyproject、typing/Pydantic v2、asyncio/FastAPI/Django/DRF、Celery、pytest/ruff/mypy/tox/nox/pre-commit、wheels/ABI、PyPI Trusted Publishing/yank、部署性能和供应链边界的开发、定位、修复与验证技能。
---

# Python 开发

Python 开发（python-development，兼容 slug: pyd）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

## 快速总则

- 先拿证据：Python 版本、解释器路径、虚拟环境、入口命令、依赖锁、pyproject、平台架构、首个 traceback；未读取就标“需验证”。
- 先复现再改：保留最小输入、命令/API、日志、期望/实际；偶发问题补并发量、数据样本、时间窗口和环境差异。
- 只守 Python 层：语言语义、类型、Pydantic、asyncio、FastAPI/Django 实现、ORM 调用方式、pytest、工具链、部署运行时、脚本副作用；不展开 DB/API/发布设计细节。
- 公共边界默认有类型：函数签名、TypedDict/dataclass/Pydantic/Protocol/Literal/Enum 选型要匹配运行时校验需求。
- async 链路默认无阻塞：网络、DB、文件、子进程、锁、队列等待必须有 timeout、取消路径、关闭路径和限并发。
- 依赖工具链只认项目权威入口：uv、uv workspace、poetry、pip-tools、pdm、hatch、requirements 不能混用；改依赖必须同步 lockfile、workspace 成员和 CI 命令。
- 改公共对象先搜消费方：schema、settings、Depends、DRF serializer/viewset、model、Celery 任务、异常结构、CLI 参数、fixture、导入路径都要查生产方和消费方。
- 交付必须有证据：ruff/mypy/pytest/最小运行命令；无法跑说明原因、风险和替代验证。

## 单技能工程门禁

- 先定运行入口：明确这是库、Web 服务、CLI、脚本、队列任务、测试修复还是构建发布；未确认入口时不得只改一个函数就报完成。
- 先定数据边界：请求体、DTO/schema、domain object、ORM model、response model、settings、fixture 要分清；typing 只约束开发期，运行时输入必须靠 Pydantic/serializer/form/显式校验。
- 先定状态边界：全局变量、缓存、connection/session/client、fixture、monkeypatch、环境变量修改必须有作用域、清理和并发语义；禁止靠“单测顺序”或“进程常驻状态”成立。
- 先定失败语义：外部 I/O、DB、队列、文件、subprocess、第三方 SDK 必须有 timeout、错误分类、retry/backoff、幂等键或去重策略；禁止无限重试和吞异常。
- 先定事务语义：多表写、状态机、扣减、发消息、文件落地、任务投递必须说明 commit/rollback、outbox/补偿、重复执行和部分失败行为。
- 先定验收证据：最少给出与项目一致的 `ruff`、`mypy` 或 `pyright`、`pytest`、`build/import/启动` 证据；改 Web/ORM/脚本时还要给最小 API/命令/数据样本。
- 不确定时先查项目配置和官方版本差异；修复两轮无效后停止猜改，回到 traceback、输入、环境、依赖锁和首个失败点复盘。

## 硬禁止 / 低级错拦截

- 禁止请求体、表单、JSON 或外部 dict 直接构造成 ORM model 或内部 domain object；必须经白名单 DTO/schema/service 映射。
- 禁止裸 `except`、`except Exception: pass`、只打印不抛、丢 traceback、把所有异常统一返回成功或 500。
- 禁止生产 `DEBUG=True`、`reload=True`、交互式 traceback、print 泄露 token/cookie/password/Authorization、把 secret 写进默认配置或镜像层。
- 禁止 async 函数内直接 `requests`、同步 SQL client、`time.sleep`、无 timeout subprocess、无限 `gather` 或未关闭 client/session。
- 禁止 SQLAlchemy/Django session/queryset 跨请求、跨线程、跨进程复用；禁止异常后不 rollback、commit 前发外部消息、rowcount 为 0 仍报成功。
- 禁止 `exclude_none=True` 当 PATCH 通用方案；清空字段、未传字段、默认值字段必须用 `model_fields_set`/`exclude_unset` 和字段白名单区分。
- 禁止 mutable default、模块级可变缓存污染请求/测试、fixture 共享可变对象、测试依赖执行顺序、mock 掉被测核心逻辑。
- 禁止混用 uv/poetry/pip-tools/pip freeze；禁止只改 requirements 不改 lock；禁止系统 Python 上强装依赖；禁止升级全局 lint/type 规则掩盖业务修复。

## 场景执行卡
### 0. 项目结构 / 模板 / src-layout / cookiecutter

- 适用：新建包/服务、重构目录、cookiecutter 模板、monorepo Python 子项目、import 路径异常。
- 先查：pyproject、packages/package-dir、src-layout 或 flat-layout、tests 布局、入口脚本、README 示例命令、CI 工作目录、uv workspace members。
- 必须做：新项目默认 src-layout；模板参数要可重复生成且含测试/ruff/mypy/打包入口；避免靠当前目录/PYTHONPATH 偶然导入；workspace 包边界和内部依赖声明清楚。
- 易漏：tests 导入源码目录而非安装包；cookiecutter 生成后包名/import name 不一致；workspace 子包缺 pyproject；CLI entry_points 指向旧模块。
- 验证：从干净目录生成/安装，跑 import、CLI、pytest、ruff、mypy；workspace 用 uv sync/uv run 按根和子包两种入口验证。

### 1. 环境 / 入口 / 复现定位

- 适用：本地可跑线上失败、CI 失败、导入失败、升级后异常、偶发报错。
- 先查：python executable、python --version、sys.path、venv、VIRTUAL_ENV、pyproject、lockfile、入口命令、工作目录、平台架构。
- 必须做：锁定首个 traceback；区分语法、导入、依赖解析、运行时、权限、并发、外部 I/O；PEP 668 报错先判断是否系统 Python 被保护。
- 易漏：IDE 解释器与终端不同；CI 用 uv sync 但本地 pip install；Apple Silicon 装到 x86_64 wheel；PYTHONPATH 靠当前目录偶然可用。
- 验证：干净环境按项目入口重跑，输出解释器、依赖版本和原复现路径结果。

### 1.1 真实开发闭环 / 低返工落地

- 适用：用户要求“写一个功能/系统/接口/后台任务/脚本”，但没有逐项列出 Python 内部落点。
- 先查：入口、调用方、输入 DTO、输出 DTO、service/domain、repo/ORM、settings、错误映射、日志字段、测试入口、构建入口。
- 必须做：按“输入校验 -> service 业务规则 -> repo/外部 I/O -> 错误映射 -> 输出白名单 -> 测试/命令证据”闭环落地；只在 Python 技能内写 Python 层门禁，跨 API/DB/发布只列联动边界。
- 易漏：只写 handler 不写 service；只改 schema 不改调用方；只测 happy path；异常映射漂移；日志没有 request/task id；配置默认值掩盖缺配。
- 验证：至少覆盖成功、参数错、权限/不存在/冲突、下游超时、重复请求、旧数据/空数据；能启动的服务要给最小启动或 import 证据。

### 2. Python 3.11-3.14/3.14t 版本矩阵 / PEP 649 / 类型 / 数据结构

- 适用：公共函数、领域对象、解析器、配置、JSON/dict 转换、跨模块接口、Python 3.14/3.14t 升级或降级兼容。
- 先查：requires-python、CI tox/nox 矩阵、目标 Python 版本、类型检查器版本、调用方、运行时是否读取 annotations、C 扩展是否支持 3.14t。
- 必须做：公共签名写清参数和返回；可变默认值用 None 或 default_factory；外部 dict 用 TypedDict 或 Pydantic；结构化接口用 Protocol；固定值用 Literal/Enum；3.11 兼容项目不得使用 3.12-only 泛型语法；3.14/PEP 649 升级要跑 annotations 反射路径。
- 易漏：dict[str, Any] 扩散；3.11 CI 仍在跑但本地用 3.12 语法；ExceptionGroup/TaskGroup 语义未覆盖；PEP 649 改变 annotations 求值时机影响 Pydantic/ORM/DI；3.14t 暴露 GIL 假设；Decimal/datetime/timezone 类型边界含糊。
- 验证：mypy/pyright 按项目配置和最低支持版本跑；覆盖空值、非法类型、边界值、序列化输出、3.11/3.12/3.13/3.14/3.14t 矩阵差异。

### 3. Pydantic v2 / Settings / Schema

- 适用：请求体、响应模型、配置、字段校验、跨字段规则、序列化。
- 先查：Pydantic 版本、BaseSettings 来源、别名策略、response_model、敏感字段、旧数据兼容。
- 必须做：Create/Update/Public/Internal 分层；v2 使用 model_validate、model_dump、field_validator、model_validator、from_attributes 口径；关键配置缺失启动失败。
- 更新卡：Create 只收创建必填输入，Update 全字段可选并用 model_fields_set 判断调用方真正传入了哪些字段；Public 只暴露外部白名单，Internal 才允许服务层和 ORM 需要的内部字段；禁止用同一个 BaseModel 同时承担请求、持久化和响应。
- 更新卡：PATCH/局部更新默认用 model_dump(exclude_unset=True) 只取显式传入字段；可空字段必须区分“未传”和“传 null”，需要保留清空语义时不要盲用 exclude_none=True；输出响应时再按 Public schema 决定 exclude_none 或默认值策略。
- 更新卡：typing/dataclass/TypedDict 不是外部输入校验；来自 HTTP、队列、文件、环境变量、CLI 的数据必须经过 Pydantic/serializer/form/显式 parser，并保留非法输入测试。
- 更新卡：Pydantic/Django/FastAPI 的 request DTO、内部 command DTO、ORM entity、response DTO 必须有字段白名单映射；新增敏感字段默认不进入 Public/Response。
- 易漏：v1 validator/orm_mode/dict/json 迁移不完整；默认值掩盖生产缺配置；response model 泄露 token/password/internal flag；alias 输入输出不一致。
- 验证：正常、缺字段、非法格式、跨字段冲突、旧数据、敏感字段、env 缺失；Update 覆盖未传、传 null、传空字符串、传默认值，断言 model_fields_set、exclude_unset、exclude_none 行为符合业务语义。

### 4. asyncio / FastAPI / 并发资源

- 适用：async endpoint、批量 I/O、WebSocket、后台协程、消费者、异步 ORM。
- 先查：是否混入 requests、同步 DB client、time.sleep、阻塞 SDK、无限 gather、共享可变状态。
- 必须做：优先 async client；不得不用同步库时放 to_thread/线程池并限并发；TaskGroup/gather 明确失败语义；client/session/lock 用作用域关闭；取消保留清理路径。
- 更新卡：每个外部调用都要有 timeout；retry 必须限定次数、退避、只重试安全错误，并配幂等键或去重；取消时不得吞 CancelledError。
- 易漏：忘记 await；取消后连接未关闭；gather 一个失败丢失部分结果；依赖 GIL 保护共享 dict/list；异步 SQLAlchemy 触发隐式 lazy load。
- 验证：成功、失败、超时、取消、重复调用、限并发、资源释放、下游抖动。

### 5. FastAPI / Django 实现层

- 适用：路由、Depends、middleware、DRF serializer/viewset、权限接入、异常映射。
- 先查：框架版本、统一异常格式、认证授权入口、依赖作用域、旧路由和后台入口。
- 必须做：route/view 只编排；权限、当前用户、DB session、settings 放统一依赖/中间件；业务进 service；异常区分用户错误、权限、未找到、依赖失败、内部错误。
- 更新卡：FastAPI 的 request model、response_model、dependency 和 exception handler 要同一套错误结构；Pydantic ValidationError 映射 422 或项目约定的参数错误，业务校验错误不要伪装成 500。
- 更新卡：Django/DRF 的 serializer、queryset、permission、filter backend 要同步核对；get_queryset/filter_queryset 必须带 tenant/current user/软删过滤，不能只在 view method 里临时补 where。
- 更新卡：业务 service 不接收原始 Request、ORM model 或未过滤 dict；route/view 只做协议适配和认证上下文注入，字段映射在白名单层完成。
- 易漏：新 endpoint 绕过权限；response_model 与实际返回漂移；路由里直接开事务和拼查询；旧入口绕过新 decorator；Django list/detail 使用不同 queryset 导致租户过滤或软删过滤漂移。
- 验证：正常、参数错、未登录、无权限、越权、资源不存在、旧入口回归；Django 补 list/detail/create/update/destroy 的 queryset/filter/tenant 覆盖；API 契约变化时联动 api。

### 6. ORM 调用 / 事务 / 数据访问代码

- 适用：SQLAlchemy 2、Django ORM、session/query、关系加载、迁移调用方。
- 先查：同步/异步 session 生命周期、事务边界、N+1、旧数据、后台任务、序列化路径。
- 必须做：显式 commit/rollback/close；关系加载策略明确；批量写有幂等和失败恢复；model 改动搜查询、写入、schema、测试、脚本。
- 更新卡：SQLAlchemy update/delete 要检查 result.rowcount 或等价影响行数；Django update/delete 要检查返回数量；0 行影响要按未找到、越权、已软删、并发版本冲突分别映射，禁止静默当成功。
- 更新卡：Django Manager/QuerySet 与 SQLAlchemy repository 默认带 tenant、is_deleted/deleted_at 过滤；软删必须有 delete、restore、force delete 三条语义，restore 要检查租户和唯一约束，force delete 要有高风险门禁和影响行数证据。
- 更新卡：IntegrityError 统一映射唯一约束、外键约束、并发写冲突或数据完整性错误；Django DoesNotExist/MultipleObjectsReturned、SQLAlchemy NoResultFound/MultipleResultsFound 要进入统一错误映射，不把 ORM 原始异常直接泄露给 API。
- 更新卡：事务内禁止发 HTTP、发消息、写不可回滚文件或调用慢外部服务；确需联动时用 outbox、after_commit、补偿任务或明确幂等恢复路径。
- 易漏：全局 session；异常后未 rollback；先查后改竞态；大结果一次性加载；async ORM 隐式 I/O；queryset 忘记 tenant 或软删过滤；批量更新 rowcount 为 0 仍返回成功。
- 验证：创建、查询、更新、删除/软删、恢复、强删、事务回滚、旧数据、并发冲突；覆盖 tenant 隔离、query filter、rowcount/影响数量、IntegrityError/DoesNotExist/0 行影响映射；表结构/索引/迁移策略联动 db。

### 7. 包管理 / pyproject / uv workspace / wheels / ABI / PyPI 发布

- 适用：新增依赖、升级 Python、CI 安装失败、uv workspace、C 扩展、构建失败、发布包、PyPI Trusted Publishing、yank、依赖漂移。
- 先查：uv.lock、poetry.lock、requirements*.txt、constraints、hash、pyproject build-system、requires-python、workspace members、CI Python、平台架构、pip 受 PEP 668 保护状态、私有源配置、PyPI 项目权限和发布 workflow。
- 必须做：只改权威依赖入口；同步 lockfile/workspace；用 uv lock/poetry lock/pip-compile 的项目口径更新；检查 wheel 是否支持 Python 3.11/3.12/3.13/3.14/3.14t、musllinux/manylinux/macOS、arm64/x86_64；C 扩展核对 ABI；PyPI 发布优先 Trusted Publishing，yank 只用于安装选择修正不当作删除。
- 易漏：系统 Python 上 pip 失败后乱加 break-system-packages；Apple Silicon 混装 Rosetta；3.13/3.14 无 wheel 触发源码编译；workspace 子包未入 lock；手改 requirements 但 CI 读 lock；Trusted Publishing 环境名/audience 错；误以为 yank 会删除已安装版本。
- 验证：干净环境安装、关键依赖 import、lockfile diff、constraints/hash 变化、ruff/mypy/pytest 同 CI 口径。

### 8. pytest / ruff / mypy / tox / nox / pre-commit / 回归

- 适用：补测试、修 bug、改类型、异步测试、fixture、CI 失败、black/isort 到 ruff formatter 迁移。
- 先查：pytest 配置、markers、fixture scope、async 插件、数据库隔离、ruff/mypy 严格度、tox/nox sessions、pre-commit hooks、是否仍用 black/isort。
- 必须做：先保留原 bug 复现；测试名写场景和预期；断言具体结果；parameterize 覆盖边界；mock 外部依赖而非被测核心逻辑；异步测试不用固定 sleep；tox/nox 与 CI 矩阵同口径；pre-commit 只做可重复静态门禁；格式化规则迁移与业务修复分开。
- 更新卡：fixture 默认函数级隔离；会改环境变量、全局设置、缓存、DB、文件系统、时间、随机数的 fixture 必须自动清理；数据库测试明确事务回滚、truncate、临时 schema 或容器隔离。
- 易漏：只测 happy path；fixture 共享可变状态；时间/随机/时区 flaky；ruff 自动修引入无关大 diff；mypy 忽略掩盖真实边界。
- 验证：目标测试、相邻测试、ruff、mypy、tox/nox 指定 session、pre-commit run；失败要列首个失败和是否与本改动相关。

### 9. 脚本 / CLI / 子进程 / 批任务

- 适用：一次性脚本、导入导出、Celery/RQ/ARQ、cron、文件处理、subprocess。
- 先查：是否写数据、是否可重复执行、输入大小、编码、权限、退出码、回滚/补偿、外部副作用。
- 必须做：默认 dry-run；输出影响数量和样本；参数校验和 help；subprocess 用参数数组、timeout、check；队列任务只传 ID/简单类型并设计幂等键；Celery 明确 ack_late、retry/backoff、幂等和死信/补偿。
- 易漏：os.system/shell=True 拼用户输入；硬编码路径/密钥；失败半截不可恢复；Celery 先 ack 后失败丢任务或无限 retry 放大故障；大 CSV/JSON 一次性读入内存。
- 验证：dry-run、真实小样本、重复执行、失败重试、超时、退出码、回滚或补偿。

### 10. 部署与运行时 / ASGI WSGI / Worker

- 适用：FastAPI/Django 服务上线、gunicorn/uvicorn、容器镜像、健康检查、graceful shutdown、worker 崩溃或内存涨。
- 先查：ASGI/WSGI 入口、worker class/数量、preload、lifespan 钩子、容器用户、环境变量/secrets 注入、健康检查、信号处理、启动和关闭日志。
- 必须做：连接/客户端在 worker 启动后按作用域创建；shutdown 关闭连接和后台任务；健康检查区分存活与就绪；配置缺失启动失败；容器默认非 root 并避免把 secret 写入镜像层。
- 易漏：gunicorn preload 后复用父进程连接；uvicorn reload 用于生产；SIGTERM 未等待任务收尾；readiness 过早放流量；环境变量默认值掩盖生产缺配。
- 验证：启动、健康检查、SIGTERM graceful shutdown、worker 重启、配置缺失、并发请求与后台任务收尾；发布策略细节联动 rls。

### 11. 性能 / Profiling / 内存

- 适用：慢请求、批任务慢、CPU 飙高、内存涨、冷启动慢、多进程 RSS 放大。
- 先查：baseline、输入规模、CPU/I/O/锁等待分类、profile 工具输出、导入耗时、Pydantic/ORM 热点、worker 模型。
- 必须做：先 profile 再优化；CPU 用 cProfile/采样 profiler 口径，内存用 tracemalloc/对象增长口径；区分 I/O 等待和 CPU 计算；优化前后记录同口径基线。
- 易漏：未 profile 直接加缓存；缓存全量对象导致多进程内存放大；N+1 被误判成 Python 慢；Pydantic 序列化/校验在热路径重复执行；冷启动被依赖导入拖慢。
- 验证：profile 前后对比、输入规模说明、峰值内存、p95/p99 或批处理耗时；容量/SLO 细节联动 pfe/obs。

### 12. 多进程 / 进程池 / 信号

- 适用：multiprocessing、ProcessPool、Celery/gunicorn prefork、CPU 密集任务、模型/大对象处理。
- 先查：start method 是 fork/spawn/forkserver、传参是否可 pickle、父进程资源、进程池 shutdown、信号处理、worker 内存上限。
- 必须做：spawn/forkserver 下入口可导入且受 main guard 保护；避免传连接、锁、不可 pickle 或巨大对象；worker 启动后重建连接；池关闭/取消/超时路径明确。
- 易漏：fork 后复用 DB/HTTP 连接；把大模型对象传入 ProcessPool；子进程吞异常；SIGTERM 只杀父进程；worker 内存泄漏无上限和重启策略。
- 验证：成功、异常、超时、取消、重复任务、worker 重启、峰值内存、资源释放。

### 13. 安全 / 供应链 / SAST / 可观测

- 适用：日志、敏感数据、SSRF、反序列化、依赖来源、私有源、pip-audit、bandit、semgrep、运行时观测。
- 先查：print/DEBUG、日志字段、用户可控 URL/路径/命令、pickle/yaml/eval、pip index-url/extra-index-url、私有包命名、hash/lock、request/task id。
- 必须做：logging 保留 request/task id 和 traceback；脱敏 token/cookie/password；SSRF 校验 scheme、DNS/IP、重定向和内网段；依赖来源可追溯；私有源避免依赖混淆；pip-audit 查已知漏洞、bandit 查 Python 危险用法、semgrep 查项目规则；策略治理/SBOM/门禁归 dso。
- 更新卡：异常日志只记录必要上下文和脱敏标识；禁止把 request body、headers、env、settings 全量打进日志；安全 token 用 secrets，不用 random/time/uuid 当凭证强度来源。
- 易漏：random 做安全 token；yaml.load/pickle.loads 处理不可信输入；extra-index-url 让公网同名包优先生效；lock 无 hash；DEBUG/traceback 泄露 secret。
- 验证：高危 grep、恶意输入、缺配置启动失败、依赖来源/lock/hash 证据、pip-audit/bandit/semgrep 结果或跳过原因、worker 重启/并发场景。

### 14. Data / ML Python 工程边界

- 适用：pandas/numpy/sklearn/torch 脚本、模型推理服务、embedding/RAG 周边 Python 工程问题。
- 先查：问题是否属于 Python 运行时、依赖、类型、内存、并发、入口、测试，还是训练、特征、评估、湖仓/编排。
- 必须做：python-dev 只处理工程化边界；模型质量、特征、评估、数据血缘、湖仓、回填、token/cost 方案交 aie/de。
- 易漏：把数据口径问题当 Python bug；在 Python 技能内设计训练/eval 方案；忽略 numpy/torch wheel、CUDA/Metal、ABI 与平台差异。
- 验证：最小输入、依赖/平台证据、内存/耗时基线、工程路径回归；跨域结论标联动技能。

## 高频坑 / 防遗漏

- 环境：解释器、venv、lockfile、入口、工作目录、平台架构必须同口径。
- 版本：3.11/3.12/3.13/3.14/3.14t 矩阵、requires-python、CI 最低版本、TaskGroup/ExceptionGroup、PEP 649、JIT/free-threading 风险要明示。
- 类型：Any、裸 dict/list、可变默认值、时区/金额/Decimal、运行时 annotations 是常见扩散源。
- async：阻塞 I/O、无 timeout、取消不清理、无限并发、共享可变状态、隐式 lazy load 最容易漏。
- Schema：Pydantic v1/v2 混用、Create/Update/Public/Internal 不分层、alias 和序列化泄敏。
- Web：新路由绕权限、异常格式漂移、Depends/middleware 旧入口绕过。
- ORM：session 泄漏、N+1、事务边界不清、旧数据不兼容、迁移调用方漏改。
- DTO/Entity：请求体直绑 ORM、ORM 对象直接响应、内部字段进入 Public schema、typing 替代运行时校验。
- 工具链：PEP 668、uv/uv workspace/poetry/pip-tools 混用、lockfile 未更新、wheel/ABI/Apple Silicon 不兼容、PyPI 发布/yank 语义误判。
- 依赖锁：hash/constraints/私有源/transitive 漂移/升级回滚必须可追溯。
- 部署：ASGI/WSGI 入口、worker/preload、lifespan、健康检查、graceful shutdown、环境变量/secrets 注入要核对。
- 测试：没保留原复现、fixture 污染、异步 sleep、过度 mock、tox/nox/pre-commit 与 CI 不一致、ruff/mypy 改全局规则。
- 脚本：无 dry-run、无幂等、无 timeout、shell 拼接、硬编码密钥、退出码不清。
- 性能：无 profile 优化、CPU/I/O 混淆、缓存放大 RSS、Pydantic/ORM 热点未量化。
- 多进程：fork 后连接复用、spawn 可导入性、pickle 边界、池 shutdown、信号处理、内存上限。
- 安全供应链：pickle/yaml/eval、SSRF、日志泄敏、DEBUG、extra-index-url 依赖混淆、lock 无 hash、pip-audit/bandit/semgrep 发现项未分流。

## 输出要求

- 场景卡：说明命中了哪些卡片以及为什么。
- 版本证据：Python、解释器路径、venv、依赖管理器、lockfile、入口命令、平台架构；未查到写“需验证”。
- 根因证据：输入、命令/API、首个 traceback/log/profile、file:line、配置证据。
- 影响面：调用方、schema、settings、Depends、router/view、service、ORM、脚本、fixture、CI、部署入口、worker 配置。
- 风险点：阻塞 I/O、吞异常、session 泄漏、N+1、依赖锁漂移、脚本副作用、安全输入、配置缺失、worker/preload、graceful shutdown、供应链。
- 联动技能：只列实际读取并遵守的相邻技能，以及触发原因。
- 验证结果：ruff/mypy/pytest/最小运行命令的产出；性能/部署问题补 profile、健康检查或信号测试；无法验证要写原因、风险和替代证据。

## 约束

- 不凭旧经验判断版本行为；Python、依赖、平台、ABI、框架行为不确定必须查官方或项目证据。
- 不混用包管理器；不得只 pip install 而不更新项目权威锁文件。
- 不为了单点修复升级全局 ruff/mypy/pytest 严格度或引入新框架；black/isort 到 ruff formatter 迁移应独立变更。
- 不让 Any、裸 dict/list、可变默认值进入公共边界，除非说明原因和验证。
- async 链路不得直接调用同步阻塞 I/O；外部 I/O 必须有 timeout 和关闭路径。
- 不硬编码密钥、生产 DEBUG、日志泄敏、命令拼接、SQL 拼接、路径拼接、不可信反序列化。
- 批量写、删除、发消息、迁移脚本默认 dry-run；真实执行前必须有影响数量、样本和回滚/补偿口径。
- 部署变更不得跳过健康检查、graceful shutdown、配置缺失和 secret 注入验证；发布回滚细节交 rls。
- 依赖私有源、hash、SBOM、漏洞扫描、供应链策略只写触发边界；具体安全治理交 dso。
- API 契约、表结构/索引/迁移、发布回滚、测试矩阵、安全审计只写触发边界，具体方案交相邻技能。

## 高频 Bug 反例库

- 反例 1：错法：FastAPI async endpoint 直接 requests.get。对法：改 async client 或 to_thread，并设 timeout。根因：事件循环被同步 I/O 阻塞导致并发雪崩。
- 反例 2：错法：DB 模型同时当请求体和响应体。对法：Create/Update/Public/Internal 分层，输出白名单。根因：输入、存储、内部处理、对外响应是不同安全边界。
- 反例 3：错法：Pydantic v1 到 v2 只改 import。对法：核对 validator、model_validate、model_dump、from_attributes、alias 和响应输出。根因：v2 是行为迁移不是简单重命名。
- 反例 4：错法：全局复用 SQLAlchemy session。对法：按请求/任务作用域创建，异常 rollback，结束 close。根因：连接和事务是有限资源，泄漏会耗尽连接池。
- 反例 5：错法：脚本默认真实批量删除或发消息。对法：默认 dry-run，输出影响数量和样本，显式确认才执行。根因：脚本参数错误会直接变成批量事故。
- 反例 6：错法：本地 pip install 修好但 CI 用 uv sync。对法：确认唯一依赖入口并同步 lockfile。根因：环境来源不一致导致复现和发布不一致。
- 反例 7：错法：PEP 668 报错后在系统 Python 强行安装包。对法：使用项目 venv/uv/poetry，必要时重建隔离环境。根因：系统 Python 受外部包管理器保护，强装会破坏 OS 依赖。
- 反例 8：错法：Apple Silicon 上混装 x86_64 wheel。对法：核对 arch、wheel tag、Rosetta 状态，干净环境重装。根因：ABI/架构不一致会在 import 或运行时崩溃。
- 反例 9：错法：pytest fixture 共享可变对象，单跑过全跑失败。对法：隔离 fixture scope，数据库测试回滚或重建。根因：测试顺序依赖和状态污染破坏可重复性。
- 反例 10：错法：用户 URL 只禁 localhost 防 SSRF。对法：校验 scheme、解析后 IP、重定向链、IPv6、内网和云元数据地址。根因：攻击目标是最终连接地址，不是输入字符串。
- 反例 11：错法：共享 dict/list 依赖 GIL 保证安全。对法：加锁、队列化或改不可变结构，核对 C 扩展线程安全。根因：free-threading 预期和多线程会暴露数据竞争。
- 反例 12：错法：fork 多进程后复用父进程 DB/HTTP 连接。对法：worker 启动后重建连接，关闭继承资源。根因：跨进程复用 fd/连接状态会造成随机失败和数据错乱。
- 反例 13：错法：项目仍支持 3.11 却提交 3.12 泛型语法。对法：按 requires-python 和 CI 最低版本写兼容语法或调整矩阵并验证。根因：本地解释器能力不等于生产兼容基线。
- 反例 14：错法：gunicorn preload 后在父进程创建 DB/HTTP client。对法：在 worker 启动后创建连接并在 shutdown 关闭。根因：prefork 复制连接状态导致随机读写错乱。
- 反例 15：错法：uv 项目手改 requirements.txt。对法：修改 pyproject/uv.lock 并用 uv sync 验证。根因：CI 按 lock 安装，手改文件不进入真实环境。
- 反例 16：错法：配置 extra-index-url 且内部包名未隔离。对法：核对私有源优先级、hash/lock 和包命名策略，触发供应链审查。根因：公网同名包可能造成依赖混淆。
- 反例 17：错法：未 profile 直接缓存全量对象。对法：先定位 CPU/I/O/内存热点，再做有上限缓存并记录前后基线。根因：盲目缓存会放大内存和多进程 RSS。
- 反例 18：错法：ProcessPool 传不可 pickle 对象或大模型对象。对法：只传简单参数，在 worker 内加载/复用资源并设置超时关闭。根因：序列化边界和对象复制会造成 hang、慢启动或内存爆炸。
- 反例 19：错法：Update 模型用 exclude_none=True 生成更新字典。对法：用 model_fields_set 和 exclude_unset 区分未传与传 null，再按字段白名单决定是否允许清空。根因：null 可能是合法业务指令，和未传不是同一语义。
- 反例 20：错法：Django queryset 只在部分 view 里补 tenant 或 is_deleted 过滤。对法：把 tenant/filter/soft delete 放进 Manager/QuerySet 或统一 repository，并验证 list/detail/update/delete 同口径。根因：入口一多就会出现越权读取、软删数据复活和计数漂移。
- 反例 21：错法：SQLAlchemy/Django update/delete 不看 rowcount 或影响数量。对法：0 行影响必须映射为未找到、越权、已软删或并发冲突，并记录验证样例。根因：静默成功会让客户端误判状态，后续补偿和审计都失真。
- 反例 22：错法：直接把 ValidationError、DoesNotExist、IntegrityError 原样抛到接口。对法：统一映射参数错误、资源不存在、唯一约束/外键约束/冲突和内部错误。根因：原始异常既泄露实现细节，也会破坏 API 错误契约。
- 反例 23：错法：把 FastAPI 请求体 dict 直接解包进 SQLAlchemy model。对法：Request DTO 白名单校验后映射到 service command，再由 repo 构造持久化对象。根因：mass assignment 会让客户端写入内部字段或越权字段。
- 反例 24：错法：认为函数签名写了类型就不用校验 CLI/HTTP/队列输入。对法：外部输入进入边界时做 Pydantic/serializer/parser 校验并测非法输入。根因：typing 不会在运行时自动拒绝脏数据。
- 反例 25：错法：except Exception 后返回空列表或成功状态。对法：捕获具体异常，保留 traceback，按参数错、依赖失败、冲突或内部错误映射。根因：吞异常会隐藏数据丢失和下游故障。
- 反例 26：错法：事务里写 DB 后直接调用第三方 API 并 commit。对法：提交前只写一致性状态，外部副作用走 outbox/after_commit/补偿任务。根因：外部调用不可回滚，失败会造成状态和副作用不一致。
- 反例 27：错法：pytest fixture 改环境变量、全局 settings、缓存后不清理。对法：用 monkeypatch/tmp_path/函数级 fixture 或 finalizer 回收。根因：测试状态污染会让单跑和全跑结果不同。
- 反例 28：错法：生产启动沿用 uvicorn reload、DEBUG=True 和默认 secret。对法：生产配置启动前校验 debug、secret、allowed hosts、日志脱敏和 worker 模式。根因：开发便利配置会变成信息泄露和稳定性事故。

## 提交前自检清单

- [ ] 已确认 raw 是事实来源，增强内容只补齐缺口报告中的关键缺口，未大删改原有能力点。
- [ ] 已确认行数小于 500 且正文不含 fenced code block。
- [ ] 已确认包含快速总则、场景执行卡、高频坑 / 防遗漏、输出要求、约束、高频 Bug 反例库、提交前自检清单、2024-2026 新坑速查、与相邻技能的边界。
- [ ] 已确认反例数量不少于 15，且每条包含错法、对法、根因。
- [ ] 已覆盖 Python 3.11/3.12/3.13/3.14/3.14t、PEP 649、uv/uv workspace/poetry/pip-tools、PEP 668、pyproject、src-layout/cookiecutter、typing/Pydantic v2、asyncio/FastAPI/Django/DRF、Celery ack/retry、pytest、ruff/mypy、tox/nox/pre-commit、black/isort 边界、wheels/ABI、PyPI Trusted Publishing/yank、部署运行时、性能 profiling、供应链。
- [ ] 已覆盖 Create/Update/Public/Internal 模型分层、model_fields_set、exclude_unset、exclude_none、Django/SQLAlchemy queryset/filter/tenant/rowcount、soft delete manager/query filter/restore/force delete、ValidationError/DoesNotExist/IntegrityError/0 行影响错误映射。
- [ ] 已覆盖请求体直绑 ORM、typing 替代运行时校验、async/sync 混用、timeout/retry/idempotency、事务内外部副作用、fixture 隔离、生产 DEBUG/secret/logging 低级错。
- [ ] 已确认 API/DB/AI/Data/Release/Test/Audit/DevSecOps 只写联动边界，不写跨域设计细节。
- [ ] 已给出 ruff/mypy/pytest/运行命令证据或无法验证原因。

## 2024-2026 新坑速查

- Python 3.11：仍是大量生产基线；TaskGroup/ExceptionGroup 可用但语法和 typing 能力低于 3.12，提交前核对最低支持版本。
- Python 3.12：新泛型语法和 typing 变化要受 requires-python、CI、类型检查器共同约束；不能只因本地支持就改公共代码。
- Python 3.13：free-threaded 构建仍是预期风险点；不要把 GIL 当业务锁，C 扩展要核对线程安全和 wheel 支持。
- Python 3.13：实验性 JIT 可能影响性能观察；优化结论必须记录环境、开关和 baseline/profile。
- Python 3.14 / PEP 649：annotations 延迟求值会影响运行时反射、Pydantic、ORM、DI、插件注册；升级前跑反射路径测试。
- Python 3.14t：free-threaded 构建进入矩阵时，把共享可变状态、C 扩展、锁粒度、wheel tag 和性能基线作为显式验证项。
- PEP 668：系统 Python 受 externally-managed-environment 保护；优先项目虚拟环境、uv/poetry，而不是破坏系统包。
- uv 普及：uv sync、uv lock、uv run 与 pip/poetry 命令不能混跑；uv workspace 要核对 members、sources、lock 和 CI 工作目录；CI 与本地必须同入口。
- Pydantic v2：validator、serialization、from_attributes、settings 拆包和响应模型行为是迁移重点。
- ruff：formatter/linter 合流后容易产生大 diff；black/isort 遗留项目迁移应独立于业务修复。
- wheels/ABI：Python 3.13/3.14/3.14t、musllinux、manylinux、macOS arm64、Apple Silicon 可能缺 wheel，源码编译失败不是代码逻辑错误。
- 部署：ASGI/WSGI worker、gunicorn preload、uvicorn worker、lifespan、健康检查和 graceful shutdown 是 Python 服务事故高发点。
- 多进程：prefork worker、Celery、gunicorn、multiprocessing 会复制连接和内存；启动后重建资源并核对最大内存。
- 供应链：依赖锁、hash、constraints、私有源、extra-index-url、build backend、sdist/wheel 内容差异、PyPI Trusted Publishing、yank、pip-audit/bandit/semgrep 会影响可复现安装和依赖混淆风险；治理门禁交 dso。
- 性能：cProfile/采样 profiler/tracemalloc 等证据先于优化；区分 CPU、I/O、导入耗时、Pydantic/ORM 热点和多进程 RSS。
- 安全：pickle/yaml/eval、SSRF、路径穿越、命令拼接仍是 Python 脚本和 Web 服务高频事故源。

## 与相邻技能的边界

- API 工程/api-engineering（api）：仅当 Python 改动改变路由、状态码、错误模型、分页、认证授权、OpenAPI/SDK 契约时联动；具体契约设计归 API 工程/api-engineering（api）。
- 数据库工程/database-engineering（db）：仅当改表、字段、索引、SQL、迁移、事务隔离、慢查询或数据修复时联动；具体表结构和迁移策略归 数据库工程/database-engineering（db）。
- AI 工程/ai-engineering（aie）：仅当 Python 代码接入模型、tool use、RAG、embedding、streaming、eval、token/cost、模型推理服务时联动；模型方案归 AI 工程/ai-engineering（aie）。
- 数据工程/data-engineering（de）：仅当 Python 任务变成 CDC、批流处理、dbt、Airflow/Dagster、湖仓、数据质量或回填链路时联动；数据模型和编排归 数据工程/data-engineering（de）。
- 发布部署/release-engineering（rls）：仅当 Python 版本、wheel/ABI、构建物、容器、ASGI/WSGI worker、发布入口、灰度、回滚或生产配置受影响时联动；发布方案归 发布部署/release-engineering（rls）。
- DevSecOps/devsecops（dso）：仅当依赖混淆、hash/SBOM、pip-audit/bandit/semgrep 发现高风险、私有源治理、SAST/供应链策略受影响时联动；安全治理方案归 DevSecOps/devsecops（dso）。
- 可观测性/observability（obs）/性能工程/perf-engineering（pfe）：仅当日志/指标/trace、SLO、容量、profile 基线和线上性能判断受影响时联动；观测与容量方案归相邻技能。
- 测试验证/test-engineering（tst）：涉及 bug 修复、关键链路、并发、权限、迁移、脚本副作用或多场景回归时联动；测试矩阵和发布冒烟归 测试验证/test-engineering（tst）。
- 代码审计/code-audit（aud）：任何非纯说明类 Python 改动完成后最后收口，审计需求落地、影响面、安全质量和验证证据。