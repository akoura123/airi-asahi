---
title: 火山引擎（TTS）
description: 在 AIRI 中配置火山引擎语音合成
---

火山引擎语音合成使用 Seed-TTS 2.0 的 V3 单向流式 HTTP 接口。在 AIRI 中只需填写火山引擎新控制台签发的 API Key。

## 第一步：准备 API Key

1. 打开并登录[火山引擎控制台](https://console.volcengine.com/)。
2. 开通 Seed-TTS 2.0，并为需要使用的音色取得授权。
3. 按照[大模型语音合成 API V3 文档](https://www.volcengine.com/docs/6561/2528925?lang=zh)创建并复制新控制台鉴权使用的 **API Key**。

::: warning API Key 安全
不要公开 API Key；泄露后应立即在服务商控制台更换密钥。
:::

## 第二步：在 AIRI 中配置

1. 打开 **设置 → 服务商 → 语音合成 → 火山引擎**。
2. 填写 API Key。模型固定为 `seed-tts-2.0`，无需填写 App ID 或 Base URL。

AIRI 会通过固定的服务端转发端点，将浏览器提交的 API Key 转换为火山引擎 V3 所需的 `X-Api-Key` 请求头；该转发不会使用 AIRI 托管的火山引擎凭据。

## 第三步：验证配置

1. 在火山引擎设置页选择与 Seed-TTS 2.0 兼容的音色。
2. 输入短文本试听，确认可正常播放。
3. 再到 **设置 → 发声** 选择火山引擎及对应音色。

## 排查

鉴权失败时，确认填写的是新控制台 API Key，而不是旧版 Access Token。合成失败或没有声音时，确认账户已开通 `seed-tts-2.0` 资源，并且所选音色已授权且兼容 Seed-TTS 2.0。
