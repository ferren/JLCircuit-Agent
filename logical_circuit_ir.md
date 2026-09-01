# Logical Circuit IR 方案

> 状态：设计方案
>
> 目标：构建一个受 SKiDL 启发、适配嘉立创 EDA 和数据手册约束的逻辑电路中间表示（Logical Circuit IR）。
>
> 本文只定义架构和落地路线，不直接修改现有代码。

## 1. 摘要

Logical Circuit IR 用于描述“电路在逻辑上由哪些器件组成、每个器件有哪些引脚、引脚之间如何连接、连接需要满足哪些电气和数据手册约束，以及这些连接在具体产品中承担什么功能”。它是设计系统的核心领域模型，嘉立创 EDA 只是其中一个物化后端。

它位于自然语言、资料库、Agent 规划和嘉立创 EDA 物理编辑之间：

```text
用户意图 / 原理图 / 数据手册
            |
            v
  Logical Circuit IR（逻辑设计意图与约束）
            |
    结构化校验、ERC、语义检索、数据手册审查
            |
            v
       IR Diff / ChangeSet
            |
            v
  Materialization Backend
  （嘉立创 EDA / 其他 EDA / 网表 / 仿真）
            |
            v
  重新读取 IR + DRC/ERC + 视觉验证
```

SKiDL 的 `Part`、`Pin`、`Net`、`Bus`、层次化模块和 ERC 是本方案的设计参考，但不把 SKiDL 的 Python 代码作为系统事实来源，也不把 SKiDL 的布局生成器作为嘉立创 EDA 的执行器。

## 2. 目标与非目标

### 2.1 目标

1. 从嘉立创 EDA 的结构化对象中提取可分析的逻辑连接关系。
2. 将用户意图和数据手册要求表达为可验证的逻辑设计变更。
3. 在写入嘉立创 EDA 前检查连接完整性、电气类型和已知数据手册约束。
4. 将逻辑变更转换为带有目标对象、旧值、风险和验证条件的 ChangeSet。
5. 在写入后重新提取逻辑 IR，确认实际设计没有偏离计划。
6. 保留每个器件、引脚、约束和结论的来源证据、置信度和版本。
7. 为网表、BOM、网络表、Mermaid/DOT、差异预览和 EDA 写入提供共同数据基础。
8. 让嘉立创 EDA、其他 EDA、网表导出和仿真器共享同一逻辑设计状态。

### 2.2 非目标

- 不在第一阶段实现新的通用原理图编辑器。
- 不把图片识别结果直接视为可信的电路事实。
- 不用 ERC 代替嘉立创 EDA 原生 DRC/ERC。
- 不自动把数据手册中的模糊描述升级为确定设计规则。
- 不让模型直接写入嘉立创 EDA 原始 API。
- 不以 SKiDL Python 文件、KiCad 网表或嘉立创工程文件作为跨平台唯一格式。
- 不把嘉立创 EDA Adapter、物理图元 ID 或某一种布局格式写入上层领域模型。
- 不在逻辑 IR 中强行解决所有二维布局问题。

## 3. 核心设计原则

### 3.1 逻辑与物理分离

逻辑 IR 描述拓扑和设计要求；物理快照描述元件坐标、旋转、导线折点、标签位置和画布区域。

```text
Logical Circuit IR
  Part / Pin / Net / Bus / Interface
  电气类型、约束、来源、验证状态

Physical EDA Snapshot
  primitiveId、x/y、rotation、wire geometry、labels、visual evidence
```

逻辑连接正确，不代表二维原理图可读；二维原理图看起来整齐，也不代表网络和器件要求正确。两者必须分别验证。

### 3.2 意图来源与事实来源分离

系统需要区分以下三类对象：

- `observed`：从当前嘉立创 EDA 读取的事实；
- `planned`：用户或 Agent 计划写入的逻辑意图；
- `verified`：写入后重新读取并通过检查的结果。

对于已有设计，嘉立创 EDA 是当前事实来源，IR 是派生快照。对于新设计，经过用户确认的 IR 是逻辑意图来源，嘉立创 EDA 是其物理呈现。

### 3.3 证据不足不能默认为通过

每个数据手册约束、引脚映射和验证结果都要有状态：

```text
passed | failed | inconclusive | not_run
```

当 EDA API 没有返回完整的引脚或网络信息时，应返回 `inconclusive`，而不是根据模型推测补齐。

### 3.4 逻辑变更必须可比较、可追踪、可回滚

IR 必须能够生成规范化 JSON 和稳定哈希。每个 ChangeSet 至少关联：

- 生成时的 IR 哈希；
- 目标项目和文档；
- 受影响的逻辑对象；
- 物理对象外部 ID；
- 预期旧值；
- 变更后的预期状态；
- 验证规则和证据引用。

### 3.5 电气身份与应用语义分层

IR 必须同时回答两个不同的问题：

- 电气层：`U1.PA3` 是哪个物理引脚，它的电气类型是什么，连接到了哪个 Net；
- 应用层：这个连接在产品中具体做什么，例如“对讲键输入”或“功放开关控制”。

应用语义不能覆盖或改写原始引脚名、引脚号、网络和电气类型，而应作为可追溯的语义覆盖层。推荐保留三层信息：

```text
物理身份层     U1.PA3 / pin 12 / GPIO
电气语义层     input / active-low / pull-up required
应用语义层     talk_key / 对讲键 / 按下时触发对讲
```

这样既不会把“对讲键”误当成芯片数据手册中的原生引脚功能，又可以让 Agent、用户和检索系统按实际产品功能理解电路。应用语义必须记录来源和置信度：原理图标签、固件符号、用户明确说明、数据手册推断和模型推断的可信等级不同，不能混为已确认事实。

一个引脚也可能在不同工作模式下承担不同功能，例如正常模式是“对讲键”，下载模式是“BOOT 配置”。因此语义绑定必须允许设置 `conditions` 或工作模式，禁止把不同模式的角色错误合并。

## 4. 数据模型

下面是建议的逻辑层模型。字段名是方案级命名，后续可映射到 `packages/contracts` 的 TypeScript 类型。

```text
LogicalCircuitIR
  schemaVersion
  irId
  project
  document
  authority              observed | planned | verified
  snapshotHash
  components[]
  nets[]
  buses[]
  interfaces[]
  hierarchy[]
  constraints[]
  applicationSemantics
  evidence[]
  validation
```

### 4.1 Component

```text
Component
  logicalId               IR 内稳定 ID
  externalRefs[]          嘉立创 primitiveId、LCSC ID、库 ID 等
  reference               R1 / U3 / C5
  symbolId
  manufacturer
  manufacturerPartNumber
  value
  footprint
  description
  pins[]
  attributes
  source
```

`logicalId` 不应直接等于嘉立创 EDA 的 `primitiveId`。EDA 图元 ID 只作为 `externalRefs` 保存，因为删除重建、复制、导入和不同 EDA 版本可能导致外部 ID 变化。

### 4.2 Pin

```text
Pin
  logicalId
  componentId
  number
  name
  aliases[]
  electricalType       input | output | bidirectional | passive |
                       power-in | power-out | open-collector |
                       no-connect | unspecified
  driveStrength
  required
  connectedNetIds[]
  datasheetRoles[]     VCC、GND、EN、BOOT、FB、SDA 等
  physicalRefs[]       引脚坐标、EDA pin ID
  source
```

引脚编号、引脚名称和引脚功能必须分别保存，不能只保留一个字符串。对于 BGA、复用引脚、多单元器件和同名引脚，需要保留明确的编号优先级和别名关系。

### 4.3 Net

```text
Net
  logicalId
  name
  aliases[]
  kind                 power | ground | clock | reset | data | analog |
                       differential | generic | unknown
  pinRefs[]
  driveRequirement
  netClass
  constraints[]
  physicalRefs[]       导线、网络标签、电源符号
  source
```

一个 Net 是逻辑连接集合，不等同于一根物理导线。多个导线段、网络标签、电源符号或跨页连接可能共同表达同一个 Net。

### 4.4 Bus、Interface 和层次

```text
Bus
  logicalId
  name
  width
  lineNetIds[]
  indexOrder

Interface
  logicalId
  name
  ports[]               port name、direction、electricalType、net/bus
  constraints[]

HierarchyNode
  logicalId
  name
  parentId
  childIds[]
  componentIds[]
  netIds[]
  interfaceIds[]
```

Interface 用于描述可复用模块的边界，例如：

```text
power_input.VIN
power_input.GND
power_input.VOUT
mcu_core.VDD
mcu_core.RESET
mcu_core.SWDIO
```

### 4.5 应用语义层

应用语义层是建立在 `Component`、`Pin`、`Net`、`Interface` 和行为路径之上的项目级知识，不改变底层连接事实。建议定义为：

```text
ApplicationSemantics
  signalRoles[]
  functionalBlocks[]
  behaviorLinks[]
  terminology[]
  evidenceRefs[]

SignalSemanticBinding
  bindingId
  targetType             pin | net | component | interface | functional-block
  targetId
  role                   稳定的机器可读角色，例如 talk_key
  displayName            面向用户的名称，例如 对讲键
  aliases[]              PTT、通话键、按键输入等
  description
  direction              input | output | bidirectional | passive
  activeLevel            high | low | edge | analog-range | unspecified
  behavior               按下、释放、打开、关闭或状态转换说明
  conditions[]           normal | boot | debug 等工作模式条件
  evidenceRefs[]
  confidence              confirmed | high | medium | low
  status                 observed | proposed | confirmed | stale | conflicting
```

`role` 用于稳定检索和规则判断，`displayName` 与 `aliases` 用于中文自然语言检索，`description` 和 `behavior` 用于解释。典型绑定如下：

```text
U1.PA3
  electrical: input, active-low, pull-up required
  application: role=talk_key, displayName=对讲键
  behavior: 按下时将 PTT_KEY 拉低，触发对讲
  evidence: 用户需求 + 固件 key_scan.ptt_key + 原理图 SW1

U1.PB5
  electrical: output, push-pull
  application: role=amplifier_enable, displayName=功放开关控制
  behavior: 输出有效电平后打开 Q2，使功放电源或使能端有效
  evidence: 固件 amp_enable + 数据手册 EN 时序 + 原理图 Q2
```

应用语义与数据手册角色要明确区分：数据手册可以证明某引脚具有 `GPIO input`、`EN` 或 `active-low` 等能力和约束，但“它在本项目中叫对讲键”通常来自用户需求、固件、原理图标注或已确认的项目资料。数据手册不能凭空创造项目功能；反过来，项目功能也不能违反数据手册给出的电气能力。

除单点绑定外，还应支持 `BehaviorLink`，将一个功能关联到完整路径：

```text
BehaviorLink
  linkId
  role                  amplifier_enable
  sourceRefs[]          U1.PB5 / AMP_EN
  throughRefs[]         Rgate / Q2
  targetRefs[]          PA_EN / PA_VCC
  preconditions[]
  expectedEffects[]
  evidenceRefs[]
```

这使系统不仅能回答“功放开关接在哪个引脚”，还可以回答“这个引脚如何真正控制功放，以及中间是否缺少三极管、电阻或电源路径”。

### 4.6 分层存储模型

引入 Logical Circuit IR 后，嘉立创 EDA 不再是整个系统的中心，而只是物化层的一个后端。建议把数据拆成以下逻辑层，并为每层定义独立的存储和写入策略：

| 层 | 主要内容 | 推荐存储 | 写入方式 | 能否作为事实 |
| --- | --- | --- | --- | --- |
| Source / Evidence | 数据手册、原理图文件、固件配置、用户说明、截图、页码和哈希 | 文件制品库 + `evidence` 索引 | 原始制品追加、索引可重建 | 原始资料是事实，模型摘录不是 |
| Component Knowledge | 料号、封装、Pin 能力、典型应用和约束 | 版本化 `ComponentProfile` / `DesignConstraint` | 新版本追加，旧版本不可覆盖 | 仅对有证据字段成立 |
| Logical Topology | Component、Pin、Net、Bus、Interface、Hierarchy | 规范化 IR 快照 + 图查询索引 | 只能通过 IR Patch 生成新快照 | `observed` 或经确认的 `planned` |
| Application Semantics | 功能角色、别名、行为路径、工作模式和固件映射 | `application_semantic_bindings` + 行为索引 | 语义 Patch，保留历史版本 | 由状态和证据决定 |
| Constraint / Validation | 结构、ERC、数据手册、语义和策略检查结果 | 校验结果表 + 可复算报告制品 | 只追加运行记录，可重新计算 | 结果有时效，不是永久事实 |
| Materialization | EDA 图元 ID、导线、坐标、布局、后端能力和同步状态 | `physical_snapshots` + backend adapter 状态 | 受控 ChangeSet / EDA API | 只有重新读取并验证后的状态可信 |
| Task / Change / Audit | 用户请求、任务 lineage、IRPatch、ChangeSet、确认、重试和回滚 | SQLite 任务表、差异表、审计表 | 追加事件 + 有限状态迁移 | 审计事件不可篡改 |

存储上不要把所有内容塞进一个可任意修改的“大 JSON”。推荐采用“规范化核心字段 + `ir_json` 完整快照 + 可重建索引”的组合：

- 核心字段用于唯一性、外键、状态、哈希、版本和查询过滤；
- 完整 JSON 保存当时的设计语境，便于审计、导出和离线复现；
- Pin/Net/Role/证据关系建立索引，支持按功能和图关系查询；
- 校验结果和物化状态永远关联具体 `snapshotHash`，不能脱离快照单独解释；
- 资料制品只保存引用、内容哈希和定位信息，避免把大 PDF 或截图复制到每个 IR 中。

推荐的依赖方向是单向的：

```text
Source / Evidence
        |
        v
Component Knowledge -----> Constraint Rules
        |                         |
        +------> Logical Topology +------> Validation
                         |
                         v
                 Application Semantics
                         |
                         v
                    IR Patch / Diff
                         |
              +----------+----------+
              v                     v
       EDA Materializer       Other Backends
              |
              v
    Physical Snapshot / Readback
```

`Application Semantics` 可以引用逻辑拓扑，但不能直接改变拓扑；`Materialization` 可以引用所有已批准的上层结果，但不能反向修改上层事实。物化后的 EDA 重新读取结果必须经过 Adapter 转换回 `observed` IR，再参与比较。

### 4.7 各层约束归属和执行顺序

每条约束必须有唯一的责任层、输入对象、严重级别和结果状态。建议按以下顺序执行：

| 顺序 | 约束层 | 典型检查 | 失败后的动作 |
| --- | --- | --- | --- |
| 1 | Schema | 字段类型、枚举、必填项、版本 | 拒绝快照或 Patch |
| 2 | Identity | `logicalId`、料号、Pin 编号和外部映射唯一 | 阻止继续规划 |
| 3 | Topology | Pin/Net 存在、连接闭合、Bus 宽度、层次边界 | 阻止 ERC 和物化 |
| 4 | Electrical / ERC | 输入驱动、电源、输出冲突、NC、方向 | 高风险错误必须阻止 |
| 5 | Datasheet | 去耦、上拉、EN、BOOT、数值、工作范围和时序 | `failed` 阻止；证据不足为 `inconclusive` |
| 6 | Application Semantic | 角色方向、有效电平、功能路径、模式冲突 | 未确认角色不能作为自动事实 |
| 7 | Policy | 用户确认、权限、项目范围、风险等级、幂等性 | 不满足则不能生成写任务 |
| 8 | Backend Capability | EDA 是否支持目标对象、导线、标签、回读和回滚 | 换后端、降级或请求人工处理 |
| 9 | Physical / Native EDA | DRC/ERC、读回、异步刷新、画布可读性 | 保留 `inconclusive` 或回滚真实失败 |

约束执行器不能只返回一个布尔值，统一返回：

```text
ConstraintResult
  constraintId
  layer                  schema | identity | topology | electrical |
                         datasheet | semantic | policy | backend | physical
  subjectRefs[]
  status                 passed | failed | inconclusive | not_run
  severity               info | warning | error | blocking
  evidenceRefs[]
  snapshotHash
  explanation
  suggestedResolution
```

只有 `blocking` 且 `failed` 的约束禁止继续；`inconclusive` 不能自动降级为通过。特别是 EDA 写入成功但读模型暂时不可见时，应把“写入状态”和“验证状态”分开保存，允许 `write=succeeded, readback=inconclusive`，等待 DRC/ERC、截图或后续读回完成。

### 4.8 快照、事件和投影

建议把 IR 设计成不可变快照，而不是被多个模块原地编辑：

```text
Snapshot S0 (observed)
  -> IRPatch P1
  -> Snapshot S1 (planned)
  -> ChangeSet C1
  -> Physical execution
  -> Snapshot S2 (observed/verified)
```

每个 Snapshot 至少保存：

```text
snapshotId
projectId / documentId
parentSnapshotId
authority                 observed | planned | verified
logicalHash
physicalHash
schemaVersion
createdByTaskId
irJson
```

每个 Patch、ChangeSet 和验证运行都只引用快照，不直接引用“当前全局状态”。这样可以支持：

- 并行分析不同候选方案；
- 在不改动当前设计的情况下比较多个功能绑定；
- 失败任务按原 ChangeSet 精确重试，而不是重新让模型猜测；
- 检查任务开始时的快照是否已经漂移；
- 将“重新规划”和“按原计划重试”保持为两个不同操作。

数据库中的派生索引，如 `net_pin_index`、`semantic_role_index` 和 `evidence_subject_index`，可以删除后从快照重建；快照、Patch、ChangeSet 和审计事件不能依赖这些索引作为唯一事实来源。

## 5. 稳定身份和对象匹配

### 5.1 身份优先级

读取已有设计时，建议按以下优先级匹配同一个逻辑对象：

1. 已保存且未失效的 `logicalId` 或设计标签；
2. 嘉立创对象的稳定外部 ID；
3. `reference + symbolId + pin signature`；
4. `reference + manufacturerPartNumber + 连接摘要`；
5. 几何位置只作为辅助候选，不能单独确认身份。

### 5.2 IR 哈希

生成哈希前需要：

- 按逻辑 ID、位号、引脚号和网络名排序；
- 排除瞬时字段，例如读取时间和临时对象引用；
- 将单位、布尔值和缺失值规范化；
- 分别生成 `logicalHash` 和 `physicalHash`。

逻辑连接未变化但布局发生变化时，`logicalHash` 应保持不变，`physicalHash` 发生变化。

## 6. 输入管线

### 6.1 嘉立创 EDA → Logical IR

第一阶段由 EDA Adapter 完成：

1. 读取当前项目、文档和选区；
2. 读取原理图元件及其位号、型号、坐标和外部 ID；
3. 读取元件引脚编号、名称、功能、引脚坐标和外部 ID；
4. 读取导线几何、网络名、网络标签、电源符号和跨页连接；
5. 根据引脚坐标、导线端点和 EDA 原生网络信息构建 Net；
6. 记录无法确认的映射和 API 能力缺口；
7. 输出 `authority=observed` 的 IR 和结构化诊断；
8. 读取已有原理图标签、网络名、层次模块和项目语义绑定；
9. 对只能从命名或上下文推断出的应用角色标记为 `proposed`，不直接当作已确认事实。

当前适配器已经有元件、导线和 DRC 读取基础，但完整的 Pin/Net/Bus 提取仍需要真实 EDA API 验证。没有完成这一步，不能宣称已有设计能够可靠转换为 IR。

### 6.2 数据手册 → 器件资料和约束

数据手册不直接写入 `components` 或 `nets`，而是先形成带来源的 `ComponentProfile` 和 `DesignConstraint`：

```text
ComponentProfile
  manufacturerPartNumber
  package
  pins[]
  operatingConditions[]
  absoluteMaximumRatings[]
  typicalApplicationRefs[]
  requiredExternalComponents[]
  decouplingRequirements[]
  layoutRequirements[]
  evidenceRefs[]

DesignConstraint
  constraintId
  kind                 required-pin | forbidden-connection |
                       required-component | value-range |
                       operating-range | topology | sequence | layout
  subjectRefs[]
  expression
  severity
  evidenceRefs[]
  status
```

例如，数据手册可能产生：

```text
U1.VDD must connect to VDD_3V3
U1.GND must connect to GND
U1.EN must not float
U1.BOOT requires CBOOT between BOOT and SW
CIN 10uF required near VIN
FB divider must satisfy Rtop/Rbottom within a specified range
```

只有能够定位到手册版本、页码、表格或原图区域的约束，才可以进入自动通过路径。模型根据典型应用图提出的连接，如果没有足够证据，应标记为 `inconclusive` 并要求审查。

### 6.3 用户意图 → IR Patch

模型不直接生成完整 IR，而是生成受 schema 约束的 `IRPatch`：

```text
IRPatch
  baseSnapshotHash
  operations[]
    addComponent
    removeComponent
    updateComponent
    addNet
    connectPin
    disconnectPin
    addConstraint
    assignValue
    bindSignalRole
    updateSemanticBinding
    linkBehavior
    setModeCondition
  rationale
  evidenceRefs[]
```

应用语义操作默认只修改 IR 的语义覆盖层，不立即改变 EDA 物理对象。例如用户说“把 PA3 定义为对讲键”，可以生成 `bindSignalRole(target=U1.PA3, role=talk_key)`；只有当用户进一步要求“把对讲键连接到 SW1”时，才生成实际的 `connectPin`、`addNet` 或导线 ChangeSet。

### 6.4 应用语义绑定管线

应用语义不应完全依赖模型一次性猜测，建议采用“候选绑定 → 确定性解析 → 证据合并 → 语义校验 → 用户确认”的管线：

```text
用户描述 / 原理图标签 / 固件符号 / 数据手册 / 历史项目
                         |
                         v
                 语义候选绑定
                         |
             Pin / Net / Component 解析
                         |
       电气兼容性、模式冲突、证据和行为路径检查
                         |
       confirmed / proposed / conflicting / stale
```

来源优先级建议如下：

1. 用户明确确认的功能定义；
2. 当前项目中已确认的语义绑定；
3. 固件符号、GPIO 配置、驱动调用和测试用例；
4. 原理图网络标签、层次模块名和注释；
5. 数据手册和典型应用图提供的电气能力；
6. 模型根据命名或上下文的推断。

不同来源出现冲突时，不覆盖旧事实，而是保留多个 `evidenceRefs`，将绑定标记为 `conflicting`，要求用户确认。例如固件叫 `PTT_KEY`，而原理图网络叫 `RESET_KEY`，系统应报告冲突并展示两条证据。

语义绑定至少需要执行以下检查：

- 目标 Pin、Net 或模块确实存在，且可以追溯到稳定 `logicalId`；
- `talk_key` 绑定到输出引脚、功放使能绑定到只能输入的引脚等明显方向错误被拒绝；
- `activeLevel`、上拉/下拉、电压域和输入阈值与数据手册约束兼容；
- `BehaviorLink` 的源、经过的器件和目标路径在 IR 中完整存在；
- 同一工作模式下的角色没有互相矛盾，不同模式的复用角色有明确条件；
- 绑定有足够证据，否则只能是 `proposed` 或 `inconclusive`。

## 7. 验证层

验证应分层执行，不把不同类型的正确性混为一个布尔值。

### 7.1 结构验证

- 引用和逻辑 ID 唯一；
- 引脚引用存在；
- 网络引用存在；
- 总线宽度和索引一致；
- 多单元器件映射完整；
- 没有跨项目或跨文档对象混用。

### 7.2 基础 ERC

参考 SKiDL 的规则模型实现确定性检查：

- 未连接但必须连接的引脚；
- 输入网络没有驱动源；
- 多个不兼容输出连接到同一网络；
- 电源输入没有合适的电源输出；
- 无连接引脚被连接；
- 网络只有一个引脚；
- 驱动能力不满足接收端要求。

### 7.3 数据手册约束验证

- 必需电源、地、使能、复位和配置引脚是否连接；
- 必需去耦、电阻分压、上拉、终端和补偿网络是否存在；
- 元件值是否位于手册给出的范围；
- 工作电压、电流、频率、温度和时序是否满足条件；
- 典型应用电路中的必要拓扑是否被破坏；
- 约束是否有来源证据。

### 7.4 应用语义验证

应用语义验证与 ERC、数据手册验证分开输出，但可以引用它们的结果。重点检查：

- 功能角色是否绑定到正确的 Pin、Net、Component 或 Interface；
- 角色的方向、有效电平、触发方式和行为描述是否与电气属性一致；
- “对讲键”“功放开关”等用户角色是否能沿连接图追溯到真实器件和网络；
- 功能路径中的中间器件是否齐全，例如 GPIO → 栅极电阻 → MOSFET → 功放使能/电源；
- 数据手册约束是否支持该角色的工作方式，例如 EN 不得悬空、GPIO 不能承受目标电压；
- 正常、启动、下载、调试等模式下的语义绑定是否存在冲突；
- 每个语义结论是否有证据、来源版本和当前状态。

需要明确：语义绑定通过，不代表连线或电气设计一定正确；它只说明“这个功能名称与当前电路对象的关系自洽”。反之，电气连接通过也不代表系统知道该网络在产品中是对讲键还是其他按键。

### 7.5 物理和原生 EDA 验证

Logical IR 校验通过后仍必须：

- 将 IR Patch 转换为受控 ChangeSet；
- 用户确认高风险写操作；
- 嘉立创 EDA 执行元件、导线、标签等物理操作；
- 重新读取 Logical IR；
- 执行嘉立创 EDA 原生 DRC/ERC；
- 获取画布截图并检查可读性；
- 对比写入前后的逻辑和物理快照。

最终状态建议使用组合结果：

```text
logicalCheck       passed | failed | inconclusive
datasheetCheck     passed | failed | inconclusive
semanticCheck      passed | failed | inconclusive | review_required
edaDrcCheck        passed | failed | inconclusive
visualCheck        passed | failed | inconclusive | review_required
overall            completed | failed | inconclusive | awaiting_review
```

## 8. IR 到 ChangeSet

IR 变更不直接调用 EDA API，而是先产生可审查差异：

```text
IRPatch
  -> 规范化
  -> 逻辑影响分析
  -> ERC / 数据手册约束
  -> IR Diff
  -> ChangeSet
  -> 用户确认
  -> EDA Adapter
```

示例：增加一个 IC 及其去耦网络时，ChangeSet 可以包含：

```text
1. 创建 U3，型号、封装和符号已解析
2. 创建 C10 = 100nF，并连接 U3.VDD - GND
3. 将 U3.VDD 连接到 VDD_3V3
4. 将 U3.GND 连接到 GND
5. 将 U3.SDA 连接到 I2C_SDA
6. 将 U3.SCL 连接到 I2C_SCL
7. 执行结构化连接、ERC、DRC/ERC 和画布验证
```

每项操作应包含：

```text
operationId
  tool
  logicalTargets[]
  semanticTargets[]       role、displayName、行为路径
  externalTargets[]
expectedBefore
expectedAfter
preconditions[]
verificationRules[]
rollback
riskLevel
```

现有 `ChangeOperation.expectedBefore` 可以作为起点，但建议扩展为结构化对象，而不是任意键值集合。ChangeSet 的用户可读描述应优先使用应用语义，例如“将对讲键绑定到 U1.PA3”，同时保留“U1.PA3 → PTT_KEY → SW1”的电气细节，避免只显示机器 ID 让用户无法审查。

语义变更应区分风险：

- 仅增加或修正已存在对象的功能别名：通常是低风险、IR/知识层变更；
- 改变功能角色的电气属性、有效电平或模式条件：需要重新运行语义和数据手册校验；
- 为满足功能角色而新增器件、网络或导线：升级为物理 ChangeSet，遵守现有确认、回滚和写后验证流程。

## 9. 嘉立创 EDA 物化策略

### 9.1 读取已有设计

```text
EDA 原始对象
  -> Adapter 兼容读取
  -> Pin/Net/Bus 规范化
  -> Logical IR observed
  -> 分析和审查
```

如果 EDA API 只返回导线几何而没有网络名或引脚映射，适配器可以根据端点做候选推断，但结果必须带置信度，并且不能直接进入自动写入路径。

### 9.2 生成新设计

```text
Logical IR planned
  -> 符号和器件解析
  -> 生成初始布局方案
  -> 生成 EDA ChangeSet
  -> 用户确认
  -> 创建器件、网络标签和导线
  -> 重新提取 IR
```

布局策略应该独立于逻辑 IR：

- 逻辑 IR 决定需要哪些元件和连接；
- 布局规划器决定器件位置、朝向和区域；
- EDA Adapter 负责把布局计划转换为真实 API 调用；
- 视觉验证负责检查可读性，不负责证明电气连接正确。

### 9.3 修改已有设计

已有设计修改必须同时比较：

- 计划生成时的 `logicalHash`；
- 当前 EDA 重新读取后的 `logicalHash`；
- 计划对象的 `expectedBefore`；
- 当前对象的外部 ID 和关键字段。

逻辑状态发生漂移时，应停止写入并要求重新规划。只有读模型暂时未刷新时，才允许按照当前项目已有的 `inconclusive` 验证策略继续等待或交给 DRC/ERC 和画布复核。

## 10. 与当前仓库的集成点

### 10.1 `packages/contracts`

新增或逐步扩展：

```text
LogicalCircuitIR
CircuitComponent
CircuitPin
CircuitNet
CircuitBus
CircuitInterface
ApplicationSemantics
SignalSemanticBinding
FunctionalBlock
BehaviorLink
DesignConstraint
EvidenceReference
IRValidationResult
IRPatch
IRDiff
```

`DesignContext` 保留项目、文档、选区和 DRC 等运行时信息，并增加：

```text
logicalCircuit?: LogicalCircuitIR
physicalSnapshot?: PhysicalEdaSnapshot
applicationSemantics?: ApplicationSemantics
```

大对象仍应遵守现有上下文预算和工具结果上限，模型默认只接收受影响区域和摘要。

### 10.2 `extensions/jlcircuit-eda/src/eda-adapter.ts`

新增只读能力：

```text
extract_logical_circuit
read_component_pins
read_nets
read_buses
read_hierarchy
```

适配器负责 EDA 版本兼容、字段归一化和外部 ID 保存，不负责数据手册解释。

### 10.3 `packages/mcp`

建议新增的工具分层：

```text
easyeda_logical_circuit          read
easyeda_logical_circuit_diff     read
easyeda_validate_connectivity    read
easyeda_validate_constraints     read
easyeda_validate_semantics       read
easyeda_search_by_function       read
easyeda_preview_ir_patch         read
easyeda_apply_ir_patch           high
```

工具目录必须继续遵守 Skill 权限、风险分级、用户确认和审计边界。

### 10.4 Knowledge / Datasheet Review

数据手册层负责输出：

- 器件完整料号和候选文档；
- 引脚表和封装信息；
- 典型应用电路中的元件与连接要求；
- 电源、去耦、时钟、复位、接口和布局约束；
- 页码、行号、表格或图区域引用；
- 缺失证据和冲突证据。

它不应直接修改 IR，而应生成可审查的 `ComponentProfile` 和 `DesignConstraint`。其中，数据手册输出的是芯片能力、引脚电气角色和设计约束，不是本项目的最终应用命名。Agent Service 将数据手册约束与项目语义绑定合并校验：例如手册证明 `PA3` 可以作为低电平有效输入，用户或固件资料再证明它在项目中是“对讲键”。

数据手册中的 `EN`、`RESET`、`BOOT`、`SDA` 等名称可以作为 `datasheetRoles[]` 或候选别名保存，但只有在项目证据确认后，才应升级为 `applicationSemantics.signalRoles[]`。

### 10.5 Agent Service / ChangeSet

模型只生成 `IRPatch` 或工具调用意图。Agent Service 负责：

1. 验证 IR Patch schema；
2. 检查基准快照哈希；
3. 运行结构和电气预检；
4. 生成 IR Diff 和 ChangeSet；
5. 写入任务、确认令牌、审计和验证规则；
6. 确认后调用受控 EDA 写工具；
7. 保存执行前后 IR、DRC/ERC、截图和不确定性说明。

### 10.6 SQLite 和制品

第一阶段可以先把 IR 放在 `context_snapshots` 或任务 JSON 中；正式版本建议增加：

```text
logical_circuit_snapshots
  session_id
  project_id
  document_id
  logical_hash
  physical_hash
  ir_json
  authority
  captured_at

logical_circuit_evidence
  snapshot_id
  object_id
  evidence_type
  source_id
  document_id / chunk_id
  locator
  content_hash

ir_diffs
  diff_id
  base_snapshot_id
  target_snapshot_id
  patch_json
  validation_json

application_semantic_bindings
  binding_id
  project_id
  document_id
  target_type / target_id
  role
  display_name
  aliases_json
  conditions_json
  behavior_json
  evidence_json
  confidence
  status
  source
  updated_at

component_profiles
  profile_id
  manufacturer_part_number
  package
  source_version
  profile_json
  content_hash
  status

design_constraints
  constraint_id
  profile_id / project_id
  layer
  kind
  expression_json
  severity
  evidence_refs_json
  status

validation_runs
  run_id
  snapshot_id
  task_id
  validator_version
  result_json
  status
  created_at

physical_snapshots
  snapshot_id
  logical_snapshot_id
  backend_type
  project_id / document_id
  physical_hash
  object_map_json
  readback_status

tasks / task_events / change_sets / change_operations
  task_id / event_id / change_set_id / operation_id
  parent_task_id
  attempt
  input_snapshot_id
  status
  payload_json
  checkpoint_json
  created_at
```

截图不直接塞入 IR 或审计表，只保存制品引用、类型、大小和哈希。

### 10.7 Codex 式模块隔离和任务编排

可以借鉴 Codex 的组织方式，但借鉴重点不是复制其 UI，而是复制“任务作用域、能力边界、上下文快照、制品和可恢复状态”这套隔离模型。每个模块只拥有完成自身职责所需的输入和工具，不允许模型通过共享上下文直接跨层写数据。

建议拆分为以下模块：

| 模块 | 职责 | 允许写入 | 禁止直接做的事 |
| --- | --- | --- | --- |
| `source-ingest` | 读取原理图、数据手册、固件和用户资料，生成证据引用 | 原始制品索引、候选证据 | 修改 IR、修改 EDA |
| `component-knowledge` | 维护料号、Pin 能力、封装和数据手册约束 | 版本化 ComponentProfile、约束草案 | 根据业务名称改写 Pin 事实 |
| `logical-graph` | 构建和查询 Component/Pin/Net/Bus/Interface 图 | IR Snapshot、只读索引 | 直接调用 EDA 写 API |
| `semantic-model` | 维护对讲键、功放开关等功能角色和行为路径 | 语义 Patch、绑定索引 | 越过拓扑校验创建连接 |
| `constraint-engine` | 执行 Schema、拓扑、ERC、数据手册和语义规则 | Validation Run、报告制品 | 修改输入数据来“修复”失败 |
| `planner` | 根据用户意图和校验结果生成 IRPatch / Diff | Draft Patch、解释和候选方案 | 直接生成 EDA 操作 |
| `change-orchestrator` | 做权限、确认、幂等、任务 lineage、重试和回滚编排 | ChangeSet、任务状态、审计事件 | 自己推断连接或绕过确认 |
| `materializer` | 将已批准 ChangeSet 映射到具体 EDA 或其他后端 | EDA 物化状态、Physical Snapshot | 修改 Logical IR 作为副作用 |
| `verifier` | 读回物化结果，执行 DRC/ERC、语义回溯和视觉验证 | Verification Run、制品引用 | 把无法读回标成通过 |
| `query-service` | 按 Pin、Net、角色、功能和证据提供只读查询 | 查询缓存和索引 | 接受自然语言后直接写设计 |

模块之间只通过版本化契约通信：

```text
EvidencePackage
ComponentProfile
LogicalCircuitSnapshot
ApplicationSemanticPatch
ConstraintReport
IRPatch / IRDiff
ChangeSet
MaterializationResult
VerificationReport
```

这些对象应放在 `packages/contracts`，实现放在对应服务或扩展中。模块可以在第一阶段都运行在同一个 Node.js 进程内，但必须保持进程外的接口和权限边界；当复杂度或安全性需要时，再拆成独立 worker 或服务，不必重写领域模型。

在当前仓库中可以采用如下渐进式目录边界：

```text
packages/
  contracts/
    logical-circuit/       # Snapshot、Patch、Diff、语义和验证契约
  evidence/                # 资料制品、定位和内容哈希
  component-knowledge/    # ComponentProfile、约束解析和版本管理
  logical-ir/             # 拓扑构建、规范化、哈希、图查询
  semantic-model/         # 功能角色、别名、BehaviorLink、语义查询
  constraint-engine/       # Schema、ERC、手册和语义校验
  planner/                 # 用户意图到 IRPatch
  change-orchestrator/    # Task、确认、ChangeSet、重试、回滚、审计
  materialization/         # 后端无关的物化接口
  verifier/                # 读回、验证和制品报告
  query-service/           # 统一只读检索接口
extensions/
  jlcircuit-eda/           # 嘉立创 EDA adapter/materializer，只实现后端协议
```

这里的 `jlcircuit-eda` 不应再承载 IR 规范、数据手册解析或应用语义规则；它只负责“把后端无关的物化指令翻译成嘉立创 API，并把结果读回”。未来增加 KiCad、网表文件、仿真器或其他 EDA 时，只需实现同一个 `MaterializationBackend`，上层逻辑图和约束引擎保持不变。

后端协议建议显式声明能力，而不是让上层假设所有 EDA 都支持相同操作：

```text
MaterializationBackend
  backendType
  capabilities
    createComponent
    connectPins
    createNetLabel
    createWire
    readbackPinsAndNets
    nativeDrc
    rollback
  preview(changeSet) -> MaterializationPlan
  apply(changeSet, confirmationToken) -> MaterializationResult
  readback(scope) -> PhysicalSnapshot + LogicalCircuitSnapshot
  rollback(handle) -> RollbackResult
```

例如嘉立创 EDA 当前存在异步读模型时，`apply()` 只能报告 API 调用和返回对象状态，`readback()` 再报告逻辑是否可见；`MaterializationResult` 必须分别记录 `writeStatus`、`readbackStatus` 和 `rollbackHandle`。这样可以把后端特有的不确定性限制在物化模块内，不污染上层的拓扑和语义模型。

推荐的任务作用域类似 Codex 的 task/thread：

```text
Design Workspace
  Project / Document / Branch
    Task: inspect | infer | plan | materialize | verify
      Context Snapshot
      Allowed Capabilities
      Input Snapshot Hash
      Produced Artifacts
      Task Lineage / Attempt
      Audit Events
```

任务类型决定允许使用的能力：

| 任务类型 | 默认能力 | 默认禁止 |
| --- | --- | --- |
| `inspect` | 读取 EDA、资料和 IR，查询子图 | 任何写入 |
| `infer` | 从证据生成候选器件、约束和语义绑定 | 直接确认事实 |
| `plan` | 生成 IRPatch、Diff、验证计划 | 调用 EDA 写操作 |
| `materialize` | 执行已经确认的 ChangeSet | 改变未批准的逻辑意图 |
| `verify` | 读回、校验、截图和生成报告 | 以推断结果替代读回事实 |

一个完整请求应由编排器推进状态，而不是依赖模型在文本中说“下一轮再执行”：

```text
received
  -> context_bound
  -> evidence_ready
  -> candidate_or_patch_ready
  -> constraints_checked
  -> awaiting_user
  -> approved
  -> materializing
  -> readback_pending
  -> verified | inconclusive | failed
```

其中 `retry` 是对原 ChangeSet 和原输入快照的精确重试，`replan` 才会重新调用模型生成新的 Patch。任务必须持久化 `taskId`、`parentTaskId`、`attempt`、`currentSnapshotHash` 和 checkpoint，避免失败后重新进入“全量读取上下文 → 生成零操作 → 再要求用户重复指令”的循环。

模块隔离的验收标准不是“目录分开”，而是：

- 每个模块有明确的输入/输出 schema 和 owner；
- 无 EDA 写权限的模块无法调用物化工具；
- 任何跨层修改都表现为 Patch 或 ChangeSet，并可审计；
- 重试、恢复和并行候选方案不依赖未持久化的内存状态；
- 删除或重建派生索引不会损害快照、证据和审计事实。

## 11. 典型工作流

### 11.1 审查现有原理图

```text
1. 读取嘉立创 EDA 当前设计
2. 提取 observed Logical IR
3. 报告无法确认的 Pin/Net/Bus
4. 运行基础 ERC 和原生 DRC/ERC
5. 用户询问某个器件或网络
6. 只返回受影响子图和证据
```

### 11.2 根据数据手册加入 IC

```text
1. 确认完整料号和封装
2. 构建数据手册 ComponentProfile
3. 提取必需引脚、外围器件和数值约束
4. 生成 IRPatch
5. 运行结构检查、ERC 和数据手册约束检查
6. 展示 IR Diff、来源证据和未决问题
7. 用户确认后生成 ChangeSet
8. 嘉立创 EDA 创建器件和连接
9. 重新提取 IR、运行 DRC/ERC 和画布验证
```

### 11.3 修改后发现 EDA 读模型滞后

```text
写入 API 返回成功
  -> 外部 ID 暂时不可见
  -> 保留返回对象和操作回滚句柄
  -> 短时轮询 ID / getAll / 端点匹配
  -> 仍无法确认则返回 inconclusive
  -> 交给 DRC/ERC、截图和人工复核
```

这类状态不能简单视为写入失败，也不能在没有真实失败证据时自动回滚。

### 11.4 按应用功能检索和反向追踪

应用语义层使 IR 从“按位号和网络名查线”升级为“按产品功能查电路”。典型查询可以规范化为确定性的图查询，再由模型负责解释结果：

```text
findByApplicationRole("talk_key")
findByAlias("对讲键")
traceBehavior("amplifier_enable")
findPinsUsedByFunction("功放开关")
```

查询“对讲键接在哪个引脚？”时，系统应返回：

```text
对讲键
  -> role: talk_key
  -> pin: U1.PA3 / pin 12
  -> net: PTT_KEY
  -> component: SW1
  -> electrical: input, active-low, pull-up required
  -> evidence/status: 固件 + 原理图，confirmed
```

查询“功放怎么打开？”时，系统应沿 `BehaviorLink` 返回：

```text
U1.PB5 (amplifier_enable)
  -> AMP_EN
  -> Rgate
  -> Q2
  -> PA_EN 或 PA_VCC
  -> active behavior、时序、电平和数据手册证据
```

如果存在多个候选、模式差异或证据冲突，结果必须明确展示，而不是将一个猜测答案伪装成唯一事实。自然语言检索只负责将“对讲键”“PTT”“通话键”等词归一化到候选角色，最终命中仍由 `role`、`aliases` 和图关系确定。

## 12. 分阶段实施路线

### Phase 0：只读 IR 骨架

- 定义 `LogicalCircuitIR` 和 `IRValidationResult`；
- 将当前元件、导线读取结果转换为基础组件和网络摘要；
- 生成规范化 JSON、`logicalHash` 和网络表；
- 在 schema 中预留 `applicationSemantics`，支持手工录入已确认的功能角色；
- 增加无法确认字段和 `inconclusive` 状态；
- 不开放任何新写操作。

验收：固定测试原理图能稳定输出相同逻辑哈希；坐标变化不改变逻辑哈希；API 缺字段时明确报告数据不足。

### Phase 1：Pin/Net/Bus 和基础 ERC

- 补齐引脚读取和网络归属；
- 支持电气类型、无连接和驱动能力；
- 实现结构检查和基础 ERC；
- 增加逻辑连接查询和子图输出；
- 实现按 `role`、显示名和别名查询 Pin/Net 的只读能力；
- 增加应用语义绑定的目标存在性、方向和有效电平检查；
- 使用固定设计集覆盖普通引脚、总线、网络标签、电源符号和跨页连接。

验收：每个检查都有通过、失败和不可判定样例，结果可定位到具体对象；输入“对讲键”可以追溯到 Pin、Net 和证据。

### Phase 2：数据手册约束模型

- 将 `datasheet_evidence` 输出转换为 `ComponentProfile`；
- 定义约束类型、来源、严重级别和证据引用；
- 支持必需引脚、去耦、上拉、分压和推荐值范围；
- 允许自定义约束规则；
- 将 `datasheetRoles` 与项目级 `applicationSemantics` 分开建模，并支持证据合并；
- 支持从固件符号、原理图标签和用户描述生成 `proposed` 语义绑定；
- 未有足够证据时强制输出 `inconclusive`。

验收：至少覆盖一组真实 IC，能区分“连线正确”“约束满足”“应用角色明确”和“证据不足”。

### Phase 3：IR Patch、Diff 和 ChangeSet

- 让模型生成受 schema 约束的 IR Patch；
- 生成按元件、引脚、网络和约束组织的差异；
- 将 Patch 转换为现有 ChangeSet；
- 增加 IR 基准哈希、`expectedBefore` 和验证规则；
- 支持 `bindSignalRole`、`linkBehavior` 和带语义上下文的 Diff；
- 将功能语义变化与实际物理连线变化分别展示，并在需要时合并为一个 ChangeSet；
- 接入用户确认、任务重试、审计和回滚链。

验收：逻辑变化可以在不阅读模型长文本的情况下被用户理解、确认和撤销。

### Phase 4：嘉立创 EDA 物化

- 实现符号、器件和封装解析；
- 将逻辑网络映射为元件、引脚、标签和导线操作；
- 增加初始布局和局部布局调整；
- 写入后重新读取 IR 并比较；
- 将已确认的功能名作为网络标签、层次接口名或注释的候选输出，但不覆盖 EDA 原始引脚属性；
- 接入原生 DRC/ERC、截图和视觉检查。

验收：固定设计集可重复完成“IR → EDA → IR”闭环，逻辑差异为零或每个差异都有明确解释。

### Phase 5：模块库和规模化验证

- 定义层次化电路模块和 Interface；
- 保存经过用户确认的数据手册约束；
- 支持电源、MCU 最小系统、接口保护等模块复用；
- 建立按功能角色复用的模块接口，例如 `talk_key_input`、`amplifier_enable_path`；
- 关联固件 Pin 配置、驱动符号和测试用例，发现硬件/固件语义漂移；
- 增加 SPICE 或其他确定性仿真作为可选验证器；
- 建立结构正确性、电气正确性、数据手册符合性和视觉可读性四类评测。

## 13. 关键风险

### 13.1 EDA 数据不完整

嘉立创 EDA API 可能只暴露部分图元字段。必须把“推断出的连接”和“EDA 明确返回的连接”区分开，不能让推断结果直接支撑高风险写入。

### 13.2 数据手册约束难以完全结构化

典型应用、电源时序、布局和稳定性要求经常依赖上下文。约束提取必须保留原文证据，并允许人工确认和冲突处理。

### 13.3 逻辑 IR 与二维布局相互影响

新增或拆分网络可能改变布局和可读性；因此 IR Diff 要同时报告逻辑影响和预期物理影响，但不能用截图替代逻辑验证。

### 13.4 多来源器件身份冲突

KiCad 符号、嘉立创器件、LCSC 料号和数据手册料号可能不是一一对应。器件映射必须保存来源、匹配方法和置信度，并在不确定时请求确认。

### 13.5 过早引入 SKiDL 运行时

当前项目是 Node.js + 嘉立创 EDA 扩展。直接引入 Python/SKiDL 会增加运行时、依赖、进程和权限边界。第一阶段应实现兼容 SKiDL 思想的 TypeScript/JSON IR；未来如需使用 SKiDL，可以作为离线 ERC 或网表 sidecar。

### 13.6 应用语义被误标或过期

“对讲键”“功放开关”等名称通常不是 EDA 或数据手册直接提供的事实，可能因固件改版、原理图复制或产品型号变化而失效。必须保存来源、版本、置信度和状态，并支持 `stale`、`conflicting` 和重新确认。语义查询结果也应同时展示原始 Pin/Net，不能只返回业务名称。

### 13.7 一个引脚承担多个模式角色

复用 GPIO、BOOT、调试口和生产测试点可能在不同条件下拥有不同功能。应用绑定必须带工作模式、启动阶段或配置条件；语义验证应检查同一条件下是否冲突，并把跨模式差异作为正常设计信息保留。

## 14. 最终架构决策

推荐采用以下定位：

```text
Logical Circuit IR
  = SKiDL 风格的拓扑模型
  + 应用语义和功能行为图
  + 分层证据、约束和验证状态
  + 嘉立创 EDA 外部对象映射
  + 数据手册约束和证据
  + ChangeSet / 验证 / 回滚元数据
```

它应当成为：

- 已有原理图逻辑分析的标准输入；
- 数据手册驱动设计修改的中间状态；
- 按产品功能检索、解释和反向追踪硬件连接的知识层；
- Agent 与 EDA 适配器之间的稳定契约；
- 网表、BOM、差异预览和验证报告的共同数据源。
- 多个设计后端之间的稳定逻辑源，嘉立创 EDA 只是其中一个物化实现。

但它不应成为：

- 嘉立创 EDA 物理对象的直接替代；
- 只由模型自由生成的非验证文本；
- 数据手册结论的无来源缓存；
- 自动布局和视觉检查的唯一依据。
- 所有模块共享的可任意修改的全局状态。

第一优先级应是“只读提取 + 类型化 IR + 可解释验证”，同时为应用语义保留稳定的覆盖层；之后再推进“数据手册约束和项目功能绑定驱动的 IR Patch”以及“IR 到嘉立创 EDA 的受控物化”。

## 15. 参考资料

- [SKiDL 官方仓库](https://github.com/devbisme/skidl)
- [SKiDL 官方文档](https://devbisme.github.io/skidl/)
- [SKiDL ERC 实现](https://raw.githubusercontent.com/devbisme/skidl/master/src/skidl/erc.py)
- [SKiDL Net 实现](https://raw.githubusercontent.com/devbisme/skidl/master/src/skidl/net.py)
- [SKiDL 现有网表转换说明](https://devbisme.github.io/skidl/#converting-existing-designs-to-skidl)
- [SKiDL 布局保持式重新生成 RFC](https://github.com/devbisme/skidl/issues/316)
- [当前 JLCircuit Agent 架构](docs/current-architecture.md)
- [当前待办与验收标准](TODO.md)
