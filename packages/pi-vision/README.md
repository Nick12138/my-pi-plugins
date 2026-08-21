# 👁 pi-vision

视觉能力插件：给**没有识图功能的模型**一个"看图"工具。只暴露一个工具 `see_image`——
把图片发给你配置的视觉模型，把分析结果作为工具结果返回给主模型。
截图、报错弹窗、UI 界面、图表、照片都能让它看懂。

模型路由带**默认模型 + 回退模型**两级兜底，默认模型挂了自动换备胎。

## 模型路由

```
see_image 调用
  ├─ 传了 model 参数        → 用它（仅本次生效，优先级最高）
  ├─ 配了 PI_VISION_MODEL   → 默认视觉模型
  └─ 都没配                 → auto：自动选注册表里第一个可用且支持 image 输入的模型
        ↓ 任一环节失败（模型不存在 / 无 Key / 请求报错）
  PI_VISION_FALLBACK_MODELS 按逗号顺序逐个回退，全部失败才报错（报错里带每个模型的失败原因）
```

## 工具

```
see_image({ image, prompt, model? })
```

| 参数 | 说明 |
| --- | --- |
| `image` | 本地文件路径（相对路径按 cwd 解析）或 `data:image/...;base64,...` 的 data URL |
| `prompt` | 想让视觉模型分析/提取什么。越具体越好："逐字提取图中文字" / "这个报错是什么意思" / "描述页面布局" |
| `model` | 可选，临时指定视觉模型 `provider/modelId`，仅本次调用生效 |

## 配置（环境变量）

| 环境变量 | 控件类型 | 说明 |
| --- | --- | --- |
| `PI_VISION_MODEL` | select（视觉模型动态单选） | 默认视觉模型；选“自动选择”则由插件自动挑选可用识图模型 |
| `PI_VISION_FALLBACK_MODELS` | text | 回退视觉模型列表，英文逗号分隔，按顺序尝试 |

另有两个**仅供高级用户**的环境变量（不在配置界面显示，留空走内置默认值）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_VISION_MAX_TOKENS` | 4096 | 单次视觉调用最大输出 token 数 |
| `PI_VISION_TIMEOUT_MS` | 90000 | 单次视觉调用超时毫秒数，超时后自动回退下一个模型 |

配置界面的选项与仓库根目录 [plugins.json](../../plugins.json) 中的 `config` 声明一一对应。
工具调用的 `model` 参数优先级高于环境变量。

模型需在 pi 的模型注册表中已配置（`~/.pi/agent/models.json`），且 `input` 数组包含 `"image"`。

## 命令 / 状态栏

- `/vision` — 查看当前配置与候选模型解析结果（含不可用原因）
- 状态栏 — 配置了可用视觉模型时显示 `👁 <模型id>`，调用期间闪烁当前使用的模型

## 参考实现

调研自 pi.dev 插件目录：

- [`pi-vision-tool`](https://pi.dev/packages/pi-vision-tool) — `describe_image` 工具形态（本插件采用）
- [`pi-image-fallback`](https://pi.dev/packages/pi-image-fallback) — 通过 modelRegistry 解析模型、统一走 pi-ai 调用
- [`pi-vision-handoff`](https://pi.dev/packages/pi-vision-handoff) — 把图片描述注入上下文的自动管线（更激进，本插件未采用）
