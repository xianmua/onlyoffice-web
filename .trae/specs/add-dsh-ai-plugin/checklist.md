# Checklist

- [x] 「插件」页签出现第二个插件「DSH AI」，机器人图标正常显示（e2e 截图验证）
- [x] DSH AI 面板可独立打开/关闭，与现有 AI 助手互不干扰（autostart 串行队列限制，DSH 改为点击打开）
- [x] DSH 服务地址默认 127.0.0.1:3080，面板设置可改（.settings-dsh.json 落盘即时生效）
- [x] DSH 可用时：面板发消息 → 回复写入文档（真机 PASS：直聊回复「链路畅通」自动落文档末尾；queue 管线亦 PASS）
- [x] DSH 不可用时：面板显示明确错误（⚠️ 调用失败 + CLI stderr），不挂死
- [x] 现有 AI 助手（plugin-ai）消息写入行为不变（回归 PASS）
- [x] 保存回调与 /api/export 不受影响（未改动相关代码，回归路径无交集）
- [x] README 与 API.md 已更新
- [ ] 多人文档/登录调研结论已向用户明确交付（不实施，见会话总结）
