---
name: php-development
description: PHP开发技能实战排障版 - PHP 8.1/8.2/8.3/8.4/8.5 生命周期、特性/弃用与支持边界、Composer/package/Packagist、schema/tag/version/archive/bin/abandoned、PSR/PER、PSR-4/autoload、Laravel 11/12/13、Symfony 7/8、ThinkPHP 6/8、ThinkORM、Validate、Route、中间件、多应用与命令行、API Platform/Slim/Mezzio/WordPress/Drupal 边界、FPM/OPcache/JIT、strict_types/enum/readonly/attribute、PDO/Doctrine/Eloquent、queue/cron、session/cookie、upload/timezone/locale/CSRF/XSS/SQL injection/deserialization、PHPStan/Psalm generics/template/taint/baseline、Rector/PHP-CS-Fixer、Pest/PHPUnit。当涉及 PHP 代码、composer.json、Packagist 包发布、Laravel/Symfony/ThinkPHP/Hyperf 等 PHP 框架、PHP API、ORM、队列、上传、安全或运行时排障时必须使用。
---

# PHP 开发

PHP 开发（php-development，兼容 slug: phpd）负责本技能描述范围内的定位、执行、验证和交接边界；旧短 slug 仅作兼容 alias/URL 主键，不作为规范技能名。

> 定位：把 PHP 开发从“会写语法”收口到可排障、可验证、可上线：版本 / 运行时 / 框架 / 证据 → 场景执行卡 → 高频坑 / 防遗漏 → 输出要求 → 约束 → 高频 Bug 反例库 → 2024-2026 新坑速查 → 与相邻技能边界。
> 铁律：先确认 PHP 版本、运行 SAPI、框架版本、依赖锁和失败证据；未读配置、未搜调用方、未跑验证，不得声称已修复。

## 快速总则（版本/运行时/入口/证据）

1. 版本先行：明确目标是 PHP 8.1、8.2、8.3、8.4 还是 8.5；逐项核对生命周期、EOL/security-only 状态、弃用、语义变化、扩展兼容、框架支持矩阵和静态分析规则。PHP 8.1 已 EOL；8.2/8.3 进入 security-only 后只收安全修复；8.5 预备/升级必须查 RFC、UPGRADING、弃用日志和依赖声明。
2. 运行时先行：确认 CLI、FPM、Apache module、RoadRunner、Swoole、Octane、cron、queue worker 是否同一 PHP binary、ini、extension 和 env。
3. 框架先行：Laravel、Symfony、ThinkPHP、Hyperf 或裸 PHP 的请求生命周期、容器、配置缓存、异常层和 ORM 习惯不同，不能套同一修法。
4. 证据先行：排障必须保留报错、stack trace、日志、请求样本、php -v、php -m、php --ini、composer diagnose/audit、composer.lock diff、框架版本和复现步骤。
5. 类型默认严格：新 PHP 文件默认 declare(strict_types=1)，参数、返回值、属性类型明确；安全/金额/token 比较默认 === / !==。
6. 输入默认不可信：request、header、cookie、session、upload、queue payload、Webhook、环境变量、CSV/Excel 都先校验再使用；CSV 导出防公式注入。
7. 数据库默认参数化：PDO prepared statement、Doctrine QueryBuilder、Eloquent binding；禁止拼接 SQL injection 风险字符串，排序/列名等 SQL 结构片段走白名单。
8. 输出默认转义：模板、JSON、富文本、导出文件都防 XSS；富文本只允许白名单。
9. 依赖默认锁定：Composer 变更必须核 composer.lock、autoload、platform config、allow-plugins、scripts、私有源优先级、abandoned 包和 composer audit。
10. 改公共能力先搜全量：函数、类、接口、DTO、enum、route、event、job、command、config key、数据库字段和序列化字段都搜生产方/消费方。
11. 测试按风险分层：纯逻辑用 PHPUnit/Pest 单测；DB/队列/文件用集成测试；API/权限/状态机补 Feature/契约/冒烟；高风险联动 tst。
12. 发布默认闭环：FPM reload、OPcache/preload 刷新、worker restart/drain、healthcheck、灰度、回滚和迁移顺序必须有证据；长驻进程不得只替换文件。
13. 完成前用 aud 收口；纯说明任务除外，涉及实现、配置、依赖、队列、上传、安全或数据写链路必须审计。

## 单技能工程门禁

1. 开发前先画当前 PHP 项目的真实路径：入口文件、路由、Controller/Action、FormRequest/Validator/ThinkPHP Validate、DTO/Command、Service、Model/Entity/Repository、Resource/Serializer、Job/Event、config、migration、test，不存在的层不能臆造。
2. 新增或修改写接口时，必须同时检查请求白名单、权限/资源归属、业务状态机、事务边界、影响行数、错误映射、日志脱敏、测试证据；缺任一项不得报“完成”。
3. Controller/Action 只能做协议适配和编排；不得把验证、授权、复杂查询、事务、多步副作用和错误码散落在 Controller 里。
4. Request DTO/FormRequest/Validator 与 Model/Entity 必须分离；禁止把 request all、$_GET、$_POST、JSON 原始数组、queue payload 直接 mass assign 到 Model 或 Entity。
5. Laravel 必查 FormRequest authorize 与 rules 是否分离；validation 通过不代表 authorization 通过。Symfony 必查 Voter/Security 与 Validator/Serializer groups 是否分离。
6. Eloquent fillable/guarded 是最后一道防线，不是输入白名单；$guarded = []、forceFill、unguarded、update($request->all()) 出现时必须停下复盘。
7. PATCH/部分更新必须保留三态：缺失、不改；显式 null，按业务清空；空字符串/0/false，按字段语义处理；禁止用 empty 或 truthy/falsy 统一判断。
8. 多表写、状态变更、扣库存/余额、发券、上传后入库、Job 派发前后状态都要有事务和幂等策略；事务内禁止外部 HTTP、邮件、短信、支付和长耗时文件处理。
9. 查询默认防 N+1、全表 all、无分页、跨租户漏 scope、软删除漏筛、读写库延迟；列表接口必须有分页/上限和排序字段白名单。
10. 配置和发布必须检查 composer.lock、APP_DEBUG/display_errors、config cache、route cache、OPcache、FPM/worker reload、queue restart；生产不能靠本地 .env 行为兜底。
11. 安全默认检查 session secure/httpOnly/SameSite、CSRF、CORS、security headers、上传隔离、下载鉴权、反序列化、SQL/command/path/HTML 拼接、token/cookie/PII 日志。
12. 验收证据至少包含：PHPStan 或 Psalm、Pest 或 PHPUnit、关键 Feature/集成用例、composer validate/audit、关键请求样本、日志脱敏样本；确实无法跑时写清原因和风险。

## 场景执行卡

### 1. 版本升级 / 兼容性 / 依赖排障

- 适用：升级 PHP 8.1/8.2/8.3/8.4/8.5、框架、扩展、Composer 包或 CI 镜像。
- 输入：目标版本、当前 php -v、composer.json、composer.lock、platform config、扩展列表、框架版本、CI/runtime 镜像。
- 动作：先跑 composer check-platform-reqs、composer diagnose、composer audit；再核生命周期/EOL、弃用、动态属性、隐式 nullable、内部函数签名、extension ABI、框架支持矩阵。PHP 8.5 按 RFC/UPGRADING/CI nightly 证据预审；PHP 8.1 作为目标需说明 EOL 风险；PHP 8.2/8.3 security-only 不承诺功能修复。
- PHP 8.4/8.5重点：8.4 扫描隐式 nullable 参数、属性钩子、非对称可见性对 ORM hydration、Serializer、反射、魔术方法、readonly/DTO、表单填充、反序列化和测试替身的影响；8.5 先看新特性/弃用是否被框架、扩展、静态分析、CI 镜像支持，不用预发布行为写死生产假设。
- 证据：版本输出、lock diff、失败包名、弃用日志、静态分析结果、测试命令、升级前后行为差异。
- 失败兜底：依赖不支持目标 PHP 时先停，列阻塞包和可选版本，不硬改业务代码绕过。

### 2. Composer / PSR-4 / autoload / 供应链

- 适用：类找不到、autoload 失效、包冲突、dev/prod 依赖差异、脚本失败、Composer package/Packagist 发布、供应链风险。
- 输入：composer.json、composer.lock、vendor 状态、autoload psr-4/classmap/files、scripts、repositories、minimum-stability、allow-plugins、audit 配置、包名、type、license、require/require-dev、bin、archive、extra、abandoned、Packagist/仓库权限。
- 动作：核命名空间与路径大小写；跑 composer validate、dump-autoload -o；确认 prod 是否用了 --no-dev；检查 schema、autoload、bin 可执行入口、archive exclude、tag/version 与语义化版本、Packagist webhook/发布权限、插件、post-install 脚本、私有源优先级、abandoned 包、audit ignore 到期时间。
- 供应链：私有源防 dependency confusion；CI token 最小权限；镜像层 PHP 扩展和系统库纳入 SBOM/审计；发布包不打入 secrets、测试 fixture 大文件或生成产物；audit ignore/abandoned 必须记录原因、版本范围、替代包、失效日期和复查人。
- 证据：Class not found 堆栈、composer validate/why/why-not、autoload 映射、lockfile hash、tag 与版本号、Packagist 页面/发布日志、CI 与本地 Composer 版本、audit 输出摘要。
- 失败兜底：不能删除 composer.lock 碰运气；不能直接 rm -rf vendor 后宣称修复。

### 3. PSR / PER / 互操作规范

- 适用：公共库、框架扩展、中间件、日志、HTTP message、container、event、cache、clock、coding style、包 API。
- 动作：区分 PSR（接口/互操作/编码规范）与 PER（PHP-FIG 演进建议）；按项目事实核 PSR-1/4/12、PSR-3、PSR-7/15/17/18、PSR-11、PSR-14、PSR-16/20 等是否已采用；不要把某框架约定误写成 PSR。
- 证据：composer 依赖接口包、实现类、服务容器绑定、中间件签名、代码风格配置、向后兼容说明。

### 4. 纯 PHP 类型 / 语言特性 / DTO

- 适用：函数、DTO、Value Object、enum、readonly、attribute、序列化、日期金额计算。
- 动作：strict_types、明确 nullable、避免 mixed 泛滥；状态值优先 enum；不可变数据用 readonly；metadata 用 attribute 前先查框架读取方式。
- 风险：弱比较、数组键自动转换、null/false/0 混淆、DateTime 时区、float 金额、json_decode 返回 null 未查 json_last_error 或异常。
- PHP 8.2-8.4：动态属性弃用、readonly class、DNF types、typed class constants、json_validate、属性钩子、非对称可见性都要查 ORM/Serializer/反射兼容。
- 证据：边界用例、类型错误用例、PHPStan/Psalm 结果、PHPUnit/Pest 用例名。

### 5. Laravel / Symfony Controller / Service / Validation

- 适用：接口、表单、命令、事件监听、依赖注入、错误处理。
- 动作：Laravel 用 FormRequest/Validator、Policy/Gate、Resource、Eloquent；Symfony 用 Request/Validator、Voter/Security、Serializer、Doctrine、Messenger；Controller 只编排，业务进 Service。
- 工程门禁：FormRequest/Validator 只负责输入合法性；authorize/Policy/Voter 负责谁能操作；Service 负责业务状态机；Resource/Serializer 负责输出白名单，四者不得互相代替。
- Laravel 11/12/13：核新版骨架、bootstrap/app.php 中 middleware/exception/routing 注册、schedule 入口、queue 配置、config publish 差异；Laravel 13 预备矩阵先查 PHP 最低版本、依赖约束、官方升级指南、包兼容，不按旧 Kernel 文件假设改动有效。
- Symfony 7/8：核 security/firewall、attribute route/validation、env processor、Messenger transport、Serializer/Doctrine 组合和 prod cache warmup；Symfony 8 预备矩阵先查 PHP 最低版本、bundle 兼容、弃用清零和 LTS/非 LTS 支持周期。
- 风险：直接信任 $_GET/$_POST、手动 new 依赖、异常被吞、debug 露栈、只鉴登录不验资源归属、照搬旧版教程。
- 证据：路由、中间件/防火墙、校验规则、异常层、框架版本、Feature 测试或请求样本。

### 5T. ThinkPHP Route / Middleware / Validate / Model

- 适用：ThinkPHP 6/8 接口、控制器、路由、验证器、中间件、多应用、ThinkORM/Db、命令行、配置缓存和从 6.x 升级到 8.x。
- 先查：composer 中 `topthink/framework`、`topthink/think-orm`、`topthink/think-validate` 版本，`php think version` 或框架版本输出，入口 `public/index.php`、`app/route.php` 或 `route/*.php`、多应用目录、`app/middleware.php`、`config/*.php`、`app/ExceptionHandle.php`、`app/validate`、`app/model`、`extend`、`runtime` 和部署脚本。
- 动作：路由优先显式定义和命名，REST/API 写清 method、prefix、middleware、miss 路由和资源归属；中间件区分全局、路由组、控制器和应用级，认证、CSRF、SessionInit、跨域、日志脱敏按真实链路排顺序；Validate 只做输入合法性，权限、租户、状态机进中间件或 Service；Controller 只编排，业务进 Service，Model/Db 只做持久化和查询表达。
- 输入门禁：`$request->param()`、`input()`、`$_GET`、`$_POST`、JSON 原始数组、上传对象和 header 默认不可信；写入前用 Validate scene + 字段白名单 + 类型转换，缺失、null、false、0、空字符串必须按三态处理。
- ORM/Db 门禁：ThinkORM Model 写入要核字段白名单、只读字段、类型转换、获取器/修改器、软删除、事件、关联预载；Db 查询的 whereRaw/exp/order/group/field/table/join 等 SQL 结构片段必须白名单，值绑定不能保护列名和表达式。
- 多应用/配置门禁：多应用项目必须确认当前 app、route、middleware、provider、event、lang、view 和 config 归属；配置读取走 config 层，部署后核 `php think optimize:*`、路由缓存、配置缓存、runtime 清理、FPM/OPcache/worker reload 是否真实生效。
- 版本门禁：ThinkPHP 8 以 PHP 8.0+、PSR 依赖升级、ThinkORM 3/4 兼容和 6.0/6.1 升级路径为基线；涉及 PHP 8.4/8.5、ThinkORM4、路由/验证改动时必须查官方 release、Packagist 和项目 lockfile，不按旧 5.x/6.x 教程直接改。
- 验证证据：至少覆盖路由命中/404/miss、Validate 失败、未登录、越权、跨应用路由、软删除/关联查询、SQL 注入结构片段、上传、Session/CSRF、缓存重建后请求样本和日志脱敏。

### 5A. PHP / Laravel / Symfony 写入白名单卡

- 适用：create/update/patch/import/bulk update/restore/forceDelete 等会把请求、DTO、表单或消息写入 Model、Entity、数据库、队列 payload 或外部 API 的路径。
- 请求字段白名单：Laravel 先用 FormRequest/Validator 得到 validated/safe 字段，再映射到 DTO、Command 或明确数组；Symfony 先用 Request/DTO/Form/Validator/Serializer groups 限定可写字段，再交给 Service；ThinkPHP 先用 Validate scene、字段白名单和显式映射，再交给 Service/Model；Resource/Serializer 只负责输出白名单，不能反向当写入白名单。
- fillable/guarded 边界：Eloquent fillable/guarded 只是 Model mass assignment 防线，不能替代请求字段白名单、权限校验、租户归属校验、状态机校验和字段级可写策略；guarded 为空也不代表所有请求字段可写。
- 三态字段判断：PATCH/部分更新必须区分字段缺失、字段显式 null、字段有值；PHP 数组用 array_key_exists 判断字段是否出现，不能用 isset、empty、truthy/falsy 合并 null、false、0、空字符串和缺失字段。
- DTO / Command 映射：DTO 构造必须保留三态语义；默认值只用于业务默认，不得把缺失字段误写成 null、空字符串或 false；批量导入同样先做字段白名单、类型转换、枚举校验和错误聚合。
- Eloquent 查询写入：update/delete/restore/forceDelete 前必须把 where、scope、tenant、owner、状态、软删除范围和权限条件写全；批量 update/delete 会绕过模型事件、casts/mutator 和 observer，需单独补审计、缓存、搜索索引和测试证据。
- Doctrine 查询写入：DQL/QueryBuilder/Repository 写入必须显式 tenant/owner/status 条件；flush 前后确认 UnitOfWork 变更集、乐观锁/版本字段、Entity 生命周期事件和级联影响；批量 DQL update/delete 不等同逐实体业务规则。
- 影响行数门禁：写入、删除、恢复、强删和批量任务必须检查影响行数或实体状态；0 行要映射为 not found、already done、conflict 或 no-op，不得静默返回成功；超过预期行数立即停止并复盘 where/scope/tenant 条件。
- 软删除边界：Laravel withTrashed、onlyTrashed、restore、forceDelete 必须有显式权限、租户、状态、审计和二次确认；默认查询是否排除软删除要写进证据。Doctrine soft delete/filter 同样要确认 filter 开关、恢复语义和级联删除影响。
- 错误映射：ValidationException/ConstraintViolation 映射 422；ModelNotFound/EntityNotFound 映射 404；权限/资源归属失败映射 403；状态冲突、乐观锁、重复提交映射 409；唯一键、外键、死锁、超时和事务异常不能统一吞成 500 或成功。
- 验证证据：至少覆盖字段缺失、字段显式 null、字段为 false/0/空字符串、越权字段、跨 tenant、软删除对象、restore/forceDelete、0 行影响、重复提交和错误映射样本。

### 6. ORM / PDO / 事务 / 查询性能

- 适用：PDO、Doctrine、Eloquent、查询构造、事务、分页、N+1、迁移兼容。
- 动作：参数绑定；列表分页；关联预加载；写链路显式事务；事务内不做外部 HTTP；需要事件时避免批量 update/delete 绕过模型事件。
- 写入门禁：create/update/delete/restore/forceDelete 后检查 affected rows、Entity 状态或异常；0 行不能默认成功，超预期行数必须停止；唯一键/外键/死锁/超时要映射为可诊断错误。
- 性能入口：先取慢查询日志、explain、N+1 证据、分页基线；必要时用 php-fpm slowlog、Blackfire/Xdebug profiler/Tideways 或框架 profiler 定位，而不是猜测优化。
- 风险：SQL injection、N+1、find 后 null 调用、Mass Assignment、软删除漏筛、长事务锁、读写库延迟、迁移顺序破坏滚动发布。
- 证据：SQL 日志、explain、事务边界、回滚路径、并发/重复提交测试、profile 摘要。

### 7. FPM / OPcache / JIT / Swoole / RoadRunner / 容器部署

- 适用：线上与本地行为不一致、部署后代码不生效、性能抖动、环境变量异常、长驻进程污染。
- 动作：确认 FPM pool 用户、php.ini、opcache.validate_timestamps、preload、JIT、realpath_cache、config/cache、route/cache、worker reload、容器镜像扩展。
- 发布闭环：灰度前清单包含 artifact 版本、镜像 digest、扩展列表、迁移顺序、healthcheck、OPcache/preload 刷新、FPM reload、queue drain/restart、RoadRunner/Swoole reload、回滚命令。
- 风险：CLI 与 FPM ini 不同、OPcache 未刷新、Laravel config cache 后 env() 业务直读失效、Swoole/RoadRunner/Octane 保留静态状态、单例、连接和 request-scoped 数据；容器多阶段构建漏扩展、CA 证书、Intl/mbstring。
- 证据：phpinfo/ini 输出、FPM reload 记录、worker restart、镜像 digest、缓存清理命令、请求命中版本标识、内存增长指标、健康检查结果。

### 8. queue / cron / command / 异步任务

- 适用：Laravel queue、Symfony Messenger、cron、CLI command、消费者、定时补偿。
- 动作：任务幂等、唯一键、超时、重试、失败队列、可观测日志；cron 与 Web/FPM 环境差异单独确认；部署后重启 worker。
- Job 门禁：payload 只传 ID/标量 DTO 和版本号；worker 内重新查状态、验权限/租户、拿幂等锁；catch Throwable 不能返回成功；失败队列和重放路径必须可审计。
- 发布：变更 payload schema 前确认新旧消费者兼容；滚动发布先 drain 或暂停消费；长任务确认 signal、timeout、max-jobs/max-time、max-requests 和失败重放策略。
- 风险：重复扣费/发券、超时重试并发、任务吞异常、cron PATH/PHP binary 错误、消息 schema 变更不兼容旧消费者、热重载不完整。
- 证据：job id、payload、attempt、failed_jobs、日志 trace、重放测试、worker 版本标识。

### 9. upload / 文件 / session / CSRF / Web 安全

- 适用：upload、导入导出、下载、图片处理、session 登录、CSRF、XSS、反序列化。
- 动作：上传验大小/MIME/Magic Bytes/扩展名，重命名并隔离存储；下载鉴权；session cookie 设置 secure/httpOnly/SameSite；表单和状态改变接口启用 CSRF；禁止不可信 deserialization。
- Header/cookie 门禁：确认 HTTPS 反代头可信边界、session domain/path、SameSite 对第三方跳转/支付回调影响、CSRF token 失效态、CORS 白名单、安全响应头和缓存头；不能只测本地 http。
- 风险：路径穿越、公开可执行脚本、zip slip、XSS、SQL injection、任意文件读写、session fixation、对象注入 gadget、反代 HTTPS 导致 cookie/CSRF 判断错误。
- 证据：恶意样本、上传配置、存储 ACL、cookie 配置、CSRF 失败样本、安全测试记录。

### 10. timezone / locale / i18n / 导入导出

- 适用：预约、账单、审计、报表、CSV/Excel、跨时区用户、locale 格式化。
- 动作：存储统一 UTC 或明确业务时区；输入输出保留时区；比较用不可变时间对象；locale 格式只在展示层；CSV 防公式注入。
- 风险：服务器默认 timezone 漂移、DST 重复/缺失小时、strtotime 解析歧义、Intl 扩展缺失、导出被 Excel 执行公式。
- 证据：跨时区样本、DST 边界、php.ini timezone、Intl/mbstring 扩展、导入导出用例。

### 11. 测试 / 静态分析 / 日志 / CVE

- 适用：补 PHPUnit/Pest、PHPStan/Psalm、异常日志、CI 证据、CVE 判定。
- 动作：核心规则补单测，API/权限补 Feature，DB/队列/文件补集成；PHPStan/Psalm baseline 不随意扩大；日志带上下文但脱敏；composer audit 结合版本、启用模块和利用条件判定 CVE；Rector/PHP-CS-Fixer 可辅助升级和风格收敛，但必须审 diff、分离机械改与业务改。
- 静态分析门禁：记录 PHPStan/Psalm level、Larastan/Psalm plugin、generics/template、array-shape/list/non-empty、class-string、conditional return、taint/source/sink/sanitizer 规则；baseline 只能收敛或逐项解释新增，不把扩大 baseline 当修复；泛型缺失优先补 @template/@extends/@implements/@param/@return，而不是降级到 mixed。
- 风险：只测 happy path、mock 核心逻辑、baseline 吞新问题、日志泄露 token/cookie/PII、只看 CVE 标题误判、CI allow-failure 长期掩盖。
- 证据：命令、用例名、覆盖结论、CI job、日志样本、静态分析输出和无法验证项。

## 高频坑 / 防遗漏

### 高频坑

1. 只看 PHP 版本，不看 FPM/CLI/cron/queue 是否同版本。
2. 升级依赖只改 composer.json，不提交 composer.lock。
3. PSR-4 命名空间、目录大小写在 macOS 正常、Linux 失败。
4. autoload files 有副作用，加载顺序导致函数重复定义或配置提前读取。
5. Laravel config cache 后业务代码继续 env()，线上读不到新值。
6. Symfony cache/container 未 warmup 或环境不一致，prod 才报服务缺失。
7. OPcache/preload/JIT 导致部署后旧代码仍被执行或性能回归难定位。
8. strict_types 只影响调用方文件，跨文件调用时误判类型约束。
9. enum/readonly/attribute/属性钩子引入后序列化、ORM hydration、表单反序列化不兼容。
10. typed properties 未初始化，ORM hydration 或模板读取时才爆。
11. Swoole/RoadRunner/Octane 保留静态缓存、单例、租户上下文或用户态对象。
12. Eloquent 批量 update/delete 跳过模型事件，审计/缓存/搜索索引不同步。
13. Doctrine lazy proxy 在序列化、队列、关闭 EntityManager 后触发异常。
14. PDO 默认错误模式、fetch mode、字符集未设，异常和编码行为不稳定。
15. queue 至少一次投递被当成仅一次，重试造成重复副作用。
16. cron 缺 PATH、工作目录或 env，手动跑正常、定时失败。
17. upload 只验扩展名，不验真实内容和存储执行权限。
18. session/CSRF 只按本地 http 调通，生产 https、SameSite、反代后失败。
19. XSS 只看输入过滤，不看输出上下文和富文本白名单。
20. deserialization 为兼容旧数据放开对象类型，埋下 gadget 风险。
21. Composer scripts、插件、私有源和 CI token 未审计，形成供应链入口。
22. abandoned 包、audit ignore、baseline 永久化，导致 CVE/类型问题长期被掩盖。
23. Packagist 发布未核 tag/version、archive、bin 和 schema，包安装后缺文件或多带敏感文件。
24. 把框架习惯当 PSR/PER，导致库 API 互操作性和向后兼容承诺失真。
25. php-fpm pm、max_children、内存上限缺基线，突发流量下 502 或 OOM。
26. FormRequest rules 通过后直接当作已授权，越权字段或跨租户资源被写入。
27. request all、$_POST、JSON 原始数组直接传 create/update/fill，触发 mass assignment。
28. 使用 empty 判断 PATCH 字段，误把 0、false、空字符串和字段缺失当成同一状态。
29. catch Throwable 后返回 success=true 或 200，事务、队列、调用方都以为已完成。
30. 只在 dev 开 APP_DEBUG/display_errors，本地没事；生产误开后泄露栈、env、SQL 和 token。
31. 日志打印 Authorization、Cookie、session id、remember token、支付回调原文或用户 PII。
32. queue job 没有幂等键和状态检查，worker 重试造成重复扣费、发券或外部通知。
33. ThinkPHP `$request->param()` 全量入库，越权字段、租户字段或状态字段被用户覆盖。
34. ThinkPHP 路由/中间件挂在错误应用、分组或控制器层，真实请求未经过鉴权。
35. ThinkORM/Db 动态 order、field、whereRaw、table、join 未白名单，binding 保护不到 SQL 结构。
36. ThinkPHP 部署后只替换文件，不重建路由/配置缓存、不清 runtime、不 reload FPM/OPcache，线上仍跑旧路由或旧配置。

### 防遗漏清单

- 改版本/依赖：查 PHP 版本、生命周期、扩展、Composer、composer.lock、platform、CI 镜像、FPM/queue/cron/Swoole/RoadRunner runtime、abandoned/audit ignore。
- 改类/命名空间/包：查 PSR/PER、PSR-4、autoload、大小写、classmap、composer schema、tag/version、archive、bin、Packagist、容器注册、序列化字段、属性钩子/非对称可见性兼容。
- 改接口：查 route、middleware、validation/Validate scene、Policy/Voter、Resource/Serializer、前端/SDK 消费方；ThinkPHP 另查多应用路由、miss 路由、路由缓存和中间件层级。
- 改 ORM：查 fillable/casts/relation、migration、index、N+1、软删除、事务、事件、副作用、profile/slowlog；ThinkORM/Db 另查字段白名单、获取器/修改器、whereRaw/exp/order/field/table/join 白名单。
- 改配置：查 .env.example、config cache、Symfony env vars、secret 来源、APP_DEBUG/display_errors、安全 header、部署重载、prod cache warmup。
- 改队列/cron：查 payload schema、幂等、retry/timeout、failed job、worker drain/reload、监控告警。
- 改上传/安全：查 MIME/Magic Bytes、存储 ACL、下载鉴权、XSS、CSRF、CORS、security headers、SQL injection、deserialization、session/cookie、日志脱敏、timezone/locale。
- 改测试/CI：查 PHPUnit/Pest、PHPStan/Psalm、Larastan、generics/template/taint、baseline、Rector/PHP-CS-Fixer、fixture、mock 边界、CI 命令和产物。
- 改发布：查 migration 顺序、灰度策略、healthcheck、artifact/镜像 digest、FPM/worker reload、OPcache/preload、回滚路径。

## 输出要求

PHP 任务输出必须极简但可复核：

1. 场景卡：命中哪几张卡，为什么。
2. 版本/运行时：PHP 8.1/8.2/8.3/8.4/8.5 生命周期、CLI/FPM/queue/cron/Swoole/RoadRunner、框架版本、Composer/composer.lock 证据；未知必须标未验证。
3. 影响面：生产方、消费方、路由、Model/Entity、Service、config、migration、queue、cron、upload、session、安全边界已查范围。
4. 风险点：类型、autoload、框架生命周期、ORM/事务、OPcache/JIT、long-running、注入/XSS/CSRF/deserialization、上传、队列幂等、timezone/locale、CVE/供应链。
5. 改动清单：文件与行号；未改文件则说明只做分析/远端配置更新。
6. 验证证据：命令、输出摘要、composer validate/audit、Packagist/tag 检查、测试/静态分析/请求样本、发布健康检查；未跑必须写无法验证。
7. 联动技能：是否已实际读取 tst、aud、api、db、wsec、rls，未联动说明原因。
8. 剩余缺口：阻断项、证据不足项、需用户确认项。

## 约束

- 不凭记忆判断 PHP/Laravel/Symfony/Composer 行为；版本不明先查。
- 不删除 composer.lock、vendor、cache 文件来“试试”；必须说明影响和恢复方式。
- 不在业务代码直接使用 env()；配置走框架配置层。
- 不用 @ 错误抑制符掩盖问题。
- 不用 extract() 处理用户输入。
- 不直接信 $_GET、$_POST、$_REQUEST、header、cookie、session、upload、Webhook 或 queue payload；必须经过校验、授权和字段白名单。
- 不把 Request/FormRequest/DTO/Serializer 输入直接绑定内部 Model/Entity；必须显式映射允许写字段。
- 不用 unserialize() 处理不可信输入；确需兼容旧数据必须白名单并隔离。
- 不拼接 SQL、shell 命令、路径、HTML；用参数化、转义、白名单和安全 API。
- 不用 catch Throwable 返回成功；不能为了用户体验隐藏真实失败状态。
- 不在日志、异常、队列 payload、测试快照或导出文件中记录 token、cookie、session id、密钥、身份证、手机号、支付原文等敏感数据。
- 不把 APP_DEBUG=true、display_errors=On、详细 stack trace 暴露到生产。
- 不用 $guarded = []、unguarded、forceFill、update($request->all()) 绕过字段边界；遗留代码必须先列证据和补偿。
- 不把 PHPStan/Psalm baseline 扩大当作修复。
- 不把 abandoned 包、audit ignore、CI allow-failure 当长期豁免；必须有到期和复查。
- 不引入新框架/ORM/测试框架，除非项目无同类能力且用户确认。
- 不借小修做架构重写；最小改动命中问题。
- 涉 API 契约联动 api；涉 DB 结构/迁移/慢查询联动 db；涉部署/FPM/OPcache/worker reload 联动 rls/be；涉测试矩阵联动 tst；完成前按风险由 aud 收口。

## 高频 Bug 反例库

- 反例 1：PHP 版本差异误判
  - 错：本地 PHP 8.3 通过，就宣布生产 PHP 8.1/8.2/8.4 也没问题。
  - 对：分别核 php -v、platform config、框架支持矩阵和弃用日志。
  - 根因：PHP 小版本会改变弃用、内部函数类型、扩展兼容和框架支持边界。
- 反例 2：PHP 8.4 属性钩子误用
  - 错：给 Entity/DTO 加属性钩子后不查 ORM hydration、Serializer、反射和表单填充。
  - 对：先用测试覆盖 hydration、序列化、反序列化、mock、只读/可写路径。
  - 根因：属性访问语义变化会影响框架魔术读写和反射型组件。
- 反例 3：隐式 nullable 弃用漏扫
  - 错：只跑单测不看 deprecation，PHP 8.4 CI 门禁才失败。
  - 对：扫描签名、升级静态分析规则，按显式 nullable 修复并保留弃用日志。
  - 根因：弃用可能不改变功能，却会被 CI 或生产错误级别放大。
- 反例 4：composer.lock 漂移
  - 错：只改 Composer 约束，不提交 composer.lock，CI 或生产解析到另一组依赖。
  - 对：提交 lockfile，记录 composer update/install 命令，跑 composer audit 和测试。
  - 根因：依赖解析不是确定的交付物，lockfile 才是实际版本证据。
- 反例 5：Composer abandoned/audit ignore 永久化
  - 错：忽略 abandoned 包和 audit ignore，或无期限豁免 CVE。
  - 对：记录影响版本、启用模块、利用条件、替代包、失效日期和复查计划。
  - 根因：供应链风险会随时间扩大，临时豁免不能替代修复。
- 反例 6：PSR-4/autoload 大小写问题
  - 错：Namespace 与目录大小写不一致，macOS 可用，Linux FPM 报 Class not found。
  - 对：核 PSR-4 前缀、路径大小写和 composer dump-autoload -o 结果。
  - 根因：文件系统大小写差异会放大 autoload 隐患。
- 反例 7：Laravel 11/12 新骨架改错入口
  - 错：按旧版 Kernel/Middleware 位置修改，新版 bootstrap/app.php 实际未生效。
  - 对：先确认 Laravel 版本、骨架结构、middleware/routing/exception/schedule 注册点。
  - 根因：框架版本差异会改变配置入口和生命周期。
- 反例 8：Laravel config cache/env 失效
  - 错：业务代码直接 env('PAY_KEY')，本地正常，生产 config:cache 后为空。
  - 对：env 只在 config 文件读取，业务统一 config()，部署时清/建配置缓存。
  - 根因：Laravel 配置缓存后不会按业务代码预期读取 .env。
- 反例 9：Symfony 7 prod warmup 才失败
  - 错：dev 环境可用就上线，prod cache warmup 才暴露 service/security/env processor 问题。
  - 对：跑 prod cache warmup，核 firewall、Serializer、Messenger、Doctrine 组合和 env processor。
  - 根因：Symfony prod 容器编译与 dev 动态解析行为不同。
- 反例 10：Symfony/Doctrine lazy proxy 进队列
  - 错：把 Doctrine Entity 或 lazy proxy 直接塞进 queue 消息，worker 反序列化后 EntityManager 已关闭。
  - 对：消息只传 ID/标量 DTO，worker 内重新查询并校验状态。
  - 根因：对象生命周期和进程边界不一致。
- 反例 11：FPM/OPcache 旧代码
  - 错：部署后只替换文件，FPM OPcache/preload 未刷新，用户仍命中旧逻辑。
  - 对：按部署策略 reload FPM/worker，核 OPcache 配置和版本标识。
  - 根因：长驻进程和字节码缓存不是文件系统实时视图。
- 反例 12：RoadRunner/Swoole 热重载不完整
  - 错：只发 reload 信号，不查容器单例、静态缓存、连接池和请求上下文是否刷新。
  - 对：重启或 reload 后用版本标识、内存指标、上下文污染测试验证。
  - 根因：long-running PHP 不会像 FPM 每请求重建进程状态。
- 反例 13：strict_types 作用域误解
  - 错：被调用函数文件有 strict_types，就以为所有调用都会强类型。
  - 对：确认调用方文件 strict_types，并用类型测试覆盖跨文件调用。
  - 根因：strict_types 由调用方文件决定。
- 反例 14：数组/null/false/json_decode 混淆
  - 错：用 if (!$value) 区分空数组、null、0、false、空字符串，或 json_decode 后不查错误。
  - 对：按类型精确判断，json_decode 后查 json_last_error 或 JSON_THROW_ON_ERROR。
  - 根因：PHP truthy/falsy 和数组键转换容易吞掉业务差异。
- 反例 15：异常被吞导致假成功
  - 错：catch Throwable 后只 log 不 rethrow，事务外层返回成功。
  - 对：异常按业务语义转换，失败要回滚并返回可诊断错误码。
  - 根因：错误处理边界不清会破坏一致性。
- 反例 16：PDO/ORM 事务内外部调用
  - 错：事务内调用支付/短信/HTTP，超时导致锁长持有，重试又重复副作用。
  - 对：事务内只改本地状态，外部副作用通过 outbox/event/queue 在提交后执行。
  - 根因：数据库锁与网络不确定性耦合。
- 反例 17：queue/cron 非幂等
  - 错：queue worker 或 cron 重跑时重复扣款、发券、发邮件。
  - 对：幂等键、唯一索引、状态机和执行日志共同约束副作用。
  - 根因：异步任务默认可能重复、乱序和延迟。
- 反例 18：upload 信任文件名
  - 错：直接保存 getClientOriginalName，允许 ../、双扩展或脚本文件进入 public。
  - 对：生成服务端文件名，校验大小/MIME/Magic Bytes，隔离存储并下载鉴权。
  - 根因：文件名、扩展名和 Content-Type 都是用户可控输入。
- 反例 19：XSS 只靠输入过滤
  - 错：入库前 strip_tags 后在 Blade/Twig 中用原样输出或富文本白名单缺失。
  - 对：按 HTML/属性/URL/JS 上下文输出转义，富文本用白名单净化。
  - 根因：XSS sink 在输出上下文，不只在输入点。
- 反例 20：SQL injection 动态排序
  - 错：where 用 binding，但 orderBy($request->sort) 直接拼列名。
  - 对：排序字段和方向用白名单映射，值才走 binding。
  - 根因：参数化不能保护 SQL 结构片段。
- 反例 21：deserialization 兼容旧数据
  - 错：为读取旧 session/cache 直接 unserialize 用户可控字符串。
  - 对：迁移到 JSON/标量 DTO；必须兼容时用 allowed_classes 白名单和隔离环境。
  - 根因：对象反序列化可触发 gadget 链和魔术方法。
- 反例 22：php-fpm 容量无基线
  - 错：只调大 pm.max_children，不算单进程内存、数据库连接和突发流量。
  - 对：用 slowlog、内存曲线、连接上限、OPcache hit rate、压测样本共同定容量。
  - 根因：FPM 池、DB 连接和容器内存是联动瓶颈。
- 反例 23：PHPStan/Psalm baseline 扩大
  - 错：为过 CI 扩大 baseline，泛型、array-shape、taint 新问题被吞。
  - 对：记录 level/plugin/baseline diff，只收敛或逐项解释新增问题。
  - 根因：静态分析门禁失效会把类型和安全问题延后到运行时。
- 反例 24：timezone/locale 漂移
  - 错：依赖服务器默认 timezone 和 strtotime 解析用户输入，DST 当天预约错一小时。
  - 对：输入携带时区，存储统一 UTC 或明确业务时区，展示层再按 locale 格式化。
  - 根因：时间解析受 php.ini、locale、夏令时和用户地区共同影响。
- 反例 25：FormRequest 与授权混淆
  - 错：rules 校验通过就允许更新任意订单，authorize 只写 return true。
  - 对：rules 管字段合法性，Policy/Gate/Voter 管角色、租户、资源归属和状态。
  - 根因：validation 证明输入像样，不证明操作者有权。
- 反例 26：Model mass assignment
  - 错：User::create($request->all()) 或 fill($_POST)，is_admin、tenant_id 被用户提交覆盖。
  - 对：validated/safe 字段映射 DTO，再按字段级策略写入 fillable 字段。
  - 根因：请求字段和内部持久化字段边界消失。
- 反例 27：PATCH 三态丢失
  - 错：empty($data['nickname']) 就跳过更新，用户无法清空，也会吞掉字符串 0。
  - 对：array_key_exists 判断是否出现，再按 null、空字符串、0、false 的业务语义处理。
  - 根因：PHP truthy/falsy 把业务状态压扁。
- 反例 28：Eloquent lazy/N+1 上线才爆
  - 错：本地 10 条数据正常，生产列表循环访问 relation 触发数千条 SQL。
  - 对：列表先查 SQL 日志和 query count，用 with/load、分页和字段选择收口。
  - 根因：ORM 延迟加载把性能问题藏进模板或 Resource。
- 反例 29：affected rows 被忽略
  - 错：update 返回 0 仍然回 200，实际 where 条件错或资源已被别人处理。
  - 对：按 0 行、1 行、超预期行数分别映射 not found、already done、conflict 或阻断。
  - 根因：写入结果没有进入业务判断。
- 反例 30：生产 debug 泄露
  - 错：为了排障临时开 APP_DEBUG/display_errors，错误页吐出 env、SQL、绝对路径和 token。
  - 对：生产只开受控日志和 trace id，敏感字段脱敏，debug 开关有回滚和审计。
  - 根因：把本地调试手段直接搬到外部可见环境。
- 反例 31：日志泄露 token
  - 错：记录完整 Authorization、Cookie、session、支付回调和第三方响应。
  - 对：日志只留 request id、用户/订单弱标识、状态码和脱敏后的错误摘要。
  - 根因：可观测性没有定义敏感字段边界。
- 反例 32：queue job 非幂等
  - 错：Job handle 里直接扣库存发券，超时重试后重复执行。
  - 对：幂等键、唯一约束、状态机、outbox/执行日志共同约束副作用。
  - 根因：队列语义通常是至少一次，不是刚好一次。
- 反例 33：session/csrf 只测本地
  - 错：本地 http 表单正常，生产 HTTPS 反代后 secure/SameSite/domain/CSRF 全变。
  - 对：按真实域名、反代头、第三方跳转、支付回调和失效 token 样本验证。
  - 根因：cookie 与 CSRF 行为依赖浏览器、协议、域名和代理。
- 反例 34：composer.lock 与 config cache 漏收口
  - 错：composer update 后只提交代码，部署不重建 config/route cache，也不重启 worker。
  - 对：提交 lock、记录 install/audit、重建缓存、reload FPM、restart/drain worker 并冒烟。
  - 根因：PHP 交付物包括依赖锁、缓存和长驻进程状态。

## 提交前自检清单

- [ ] 行数 < 500，且无 fenced code block。
- [ ] 必需章节齐全：快速总则、场景执行卡、高频坑 / 防遗漏、输出要求、约束、高频 Bug 反例库、提交前自检清单、2024-2026 新坑速查、与相邻技能的边界。
- [ ] 已覆盖 PHP 8.1 EOL、PHP 8.2/8.3 security-only、PHP 8.4、PHP 8.5 的生命周期、版本差异、迁移动作和验证证据。
- [ ] 已覆盖 Composer、composer.lock、package/Packagist 发布、schema、tag/version、archive/bin、PSR/PER、PSR-4、autoload、allow-plugins、scripts、私有源、abandoned、SBOM/audit ignore。
- [ ] 已覆盖 Laravel 11/12/13 预备矩阵、Symfony 7/8 预备矩阵、ThinkPHP 6/8、ThinkORM/Db、Validate scene、Route、中间件、多应用、配置/路由缓存、API Platform/Slim/Mezzio/WordPress/Drupal 边界、FPM、OPcache、JIT、Swoole、RoadRunner、容器部署。
- [ ] 已覆盖 strict types、typed properties、enum、readonly、attribute、属性钩子、非对称可见性。
- [ ] 已覆盖 PDO、Doctrine、Eloquent、事务、迁移顺序和查询性能。
- [ ] 已覆盖 queue、cron、session/cookie、upload、timezone/locale、CSRF、XSS、SQL injection、deserialization。
- [ ] 已覆盖 Request DTO/FormRequest 与 Model 分离、fillable/guarded、mass assignment、validation/authorization 分离、affected rows、PATCH 三态。
- [ ] 已覆盖 APP_DEBUG/display_errors、session/cookie、CSRF、CORS、安全 header、composer.lock、env/config cache、OPcache/FPM/worker reload 和日志脱敏。
- [ ] 已覆盖 queue job 幂等、payload schema 兼容、失败队列、重试、重放、worker restart 的证据口径。
- [ ] 已覆盖 CVE/供应链、Psalm、PHPStan、Larastan、generics/template/taint、Pest、PHPUnit、baseline 收敛的验证口径。
- [ ] 已覆盖 FPM pool、OPcache 指标、slowlog、profiling、内存泄漏、长驻 worker max-requests、N+1 基线。
- [ ] 反例库不少于 10 条，且覆盖版本、Composer/lock、autoload、框架、FPM/OPcache、类型、数组/null、异常、PDO/ORM/事务、队列/任务、上传/文件、安全。
- [ ] 输出要求要求列版本/运行时/影响面/验证证据/剩余缺口。
- [ ] 与 be、api、db、wsec、rls、tst、aud 的边界清楚。

## 2024-2026 新坑速查

- PHP 8.5：预备期先查 RFC/UPGRADING、弃用清单、扩展 ABI、CI 镜像、静态分析和框架支持；不得把 nightly/pre-release 行为当生产承诺。
- PHP 8.4：属性钩子、非对称可见性、隐式 nullable 参数弃用、扩展兼容和静态分析规则更新；升级前先跑弃用日志、依赖支持矩阵、ORM/Serializer hydration 用例和静态分析。
- PHP 8.3：typed class constants、json_validate、Randomizer 增强；框架/库可能开始使用新语法，反向兼容 PHP 8.1/8.2 要查 platform。
- PHP 8.2/8.3：处于 security-only 时优先规划升级窗口；动态属性弃用、readonly class、DNF types、typed class constants、json_validate 等会影响兼容声明和 platform 约束。
- PHP 8.1：已 EOL；只能作为遗留约束处理，需列风险、隔离补偿和升级路径；enum、readonly property、intersection types、fibers 仍需查保留字、序列化和框架版本。
- Composer 2.7/2.8+：audit 更常进入 CI 门禁；package/Packagist 发布必须核 schema、tag/version、archive、bin、license、abandoned；插件权限、allow-plugins、scripts、私有 registry 优先级、dependency confusion、audit ignore 到期机制要核。
- Laravel 11/12/13：默认骨架、中间件注册、队列/调度、配置发布方式与旧版不同；Laravel 13 预备先查最低 PHP、Symfony 组件、第一方包和社区包兼容，照搬旧教程前先查项目实际版本和 bootstrap/app.php。
- Symfony 7/8：attribute 路由/验证、安全配置、Doctrine 版本组合影响大；Symfony 8 预备先查最低 PHP、bundle 兼容、弃用清零和 cache warmup，env processor、Messenger/Serializer 在 prod 暴露问题更多。
- ThinkPHP 8：以 PHP 8.0+、PSR 依赖升级、ThinkORM 3/4、Validate 独立依赖、路由/中间件/验证改动和 6.0/6.1 升级路径为重点；不要把 5.x/6.x 教程直接套到 8.x，先核 `topthink/framework`、`think-orm`、`think-validate`、路由缓存和多应用结构。
- FPM/OPcache/JIT/preload：性能优化可能改变排障路径；启用前后要有基线，部署必须有 reload、healthcheck 和回滚策略。
- Swoole/RoadRunner/Octane：长驻 worker 保留内存状态；request-scoped 服务、静态缓存、连接池、协程上下文、单例污染要单独测试。
- 容器部署：多阶段镜像可能漏扩展、时区包、CA 证书和 Intl/mbstring；CLI/FPM 镜像 tag 与 digest 必须可追溯。
- 发布顺序：迁移、缓存构建、FPM reload、queue drain/restart、healthcheck、灰度、回滚都要闭环；DB 兼容性需支持滚动发布。
- 性能容量：php-fpm slowlog、OPcache hit rate、FPM pool sizing、内存泄漏、N+1、分页和 profiler 输出是优先证据。
- CVE/供应链：判断命中必须核版本、启用模块、运行配置和利用条件；Composer scripts、post-install 插件、私有源、镜像层、CI token 泄露是 PHP 项目高频入口。
- Web 安全：SameSite/CHIPS/反代 HTTPS 影响 session/CSRF；富文本、上传、导出和反序列化仍是 XSS/SQL injection/deserialization 高危入口。
- 静态分析：PHPStan/Psalm 对 generics/template、array shape/list、class-string、conditional return、taint/source/sink/sanitizer 分析更常用于门禁；Larastan/Psalm plugin 需匹配框架版本；baseline 只能减小，不能扩大掩盖新风险。

## 与相邻技能的边界

- 本技能负责：PHP 语言、Composer/package/Packagist/autoload、PSR/PER、Laravel/Symfony/ThinkPHP/Hyperf 按项目事实落地、API Platform/Slim/Mezzio/WordPress/Drupal 边界识别、FPM/OPcache/JIT、Swoole/RoadRunner、PDO/Doctrine/Eloquent、queue/cron、upload/session/cookie/CSRF/XSS/SQL injection/deserialization、timezone/locale、PHPStan/Psalm/Pest/PHPUnit/Rector/PHP-CS-Fixer 的开发与排障口径。
- API 工程/api-engineering（api）：负责 API 契约、状态码、认证语义、版本兼容和响应结构；PHP 开发/php-development（phpd） 只检查 PHP 落地风险。
- 数据库工程/database-engineering（db）：负责表结构、索引、迁移、慢查询和事务模型；PHP 开发/php-development（phpd） 只检查 PDO/ORM 使用、事务边界和调用证据。
- 后端工程/backend-engineering（be）：负责服务拓扑、运行环境、网关、中间件、配置、可观测性、限流熔断、服务间调用；PHP 开发/php-development（phpd） 只检查 PHP 落地风险。
- Web 安全/web-security（wsec）：负责授权范围、OWASP/ASVS、安全验证、漏洞复现与修复验证；PHP 开发/php-development（phpd） 只覆盖 PHP 相关安全编码和框架落地。
- 发布部署/release-engineering（rls）：负责 CI/CD、artifact、SBOM、签名、灰度、健康检查、监控、OPcache/worker reload、回滚和发布冒烟。
- 测试验证/test-engineering（tst）：负责需求拆条、场景矩阵、测试分层、flaky/CI 证据；PHP 开发/php-development（phpd） 只提出 PHP 相关必测风险。
- 代码审计/code-audit（aud）：负责最终需求对账、影响面追踪、安全质量收口和上线边界；PHP 改动完成前必须按风险回到 代码审计/code-audit（aud）。
- API Platform、Slim、Mezzio、Spiral、WordPress、Drupal、包开发、Composer plugin 开发按项目事实处理；涉及 API 契约、CMS 权限/插件生态、发布、供应链或安全专项时切对应相邻技能。
- security/reverse/protocol 类问题：涉及真实漏洞利用、抓包逆向、支付协议或合规时，切换对应技能；PHP 开发/php-development（phpd） 不替代专项审计。
