# OCR (Baidu) — pi 插件

把百度智能云 OCR 封装成 pi 的 `ocr_image` 工具（移植自 `baidu_ocr` Claude 技能）。

## 功能

- 通用文字识别·标准版 `general_basic`（每天 5 万次免费）
- 始终带上 `detect_direction=true`、`paragraph=true`、`probability=true`：横拍/倒置图片也能识别，且能查看方向与平均置信度
- 命中证照关键词（营业执照 / 身份证 / 发票 / 驾驶证 / 行驶证）时提示对应的专用接口，提醒交叉核对关键字段
- 图片限制：base64 ≤ 4MB、最长边 ≤ 4096px，超限给出压缩建议

## 工具

```
ocr_image(imagePath: string)
```

返回：识别文本（逐行）＋ 方向 / 行数 / 平均置信度元信息。

## 配置（环境变量，PiDeck 配置界面自动注入）

| 环境变量 | 说明 | 必填 |
| --- | --- | --- |
| `BAIDU_OCR_API_KEY` | 百度 OCR 应用 API Key | ✓ |
| `BAIDU_OCR_SECRET_KEY` | 百度 OCR 应用 Secret Key | ✓ |



密钥只存在于进程环境变量，插件代码不打印、不回传、不落盘。

## 申请密钥

1. 登录 https://cloud.baidu.com/
2. 打开 https://console.bce.baidu.com/ai/ → 文字识别 → 应用列表 → 创建应用
3. 勾选"通用文字识别"接口，创建后复制 **API Key** 和 **Secret Key** 填入插件配置

## 与原技能的差异

- 密钥不再内嵌在说明文件里，只走环境变量
- 交互模式 / `--output` JSON 落盘改为 pi 工具返回值，不产生需要手动清理的临时文件
- 证照二次调用没有写成额外 API 调用，避免误当成逐字原文；以提示形式引导交叉核对
