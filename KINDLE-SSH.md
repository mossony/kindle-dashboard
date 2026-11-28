# Kindle 局域网 SSH

从 BWPC（Windows）连接 Paperwhite 3。当前 Kindle 的局域网地址是
`192.168.2.122`，SSH 端口是 `2222`。Kindle 的防火墙只允许 BWPC 的
局域网地址 `192.168.2.18` 连接，登录必须使用专用 SSH 密钥。

1. 确认 Kindle 已唤醒且连上家里的 Wi-Fi。手动锁屏会断开 Wi-Fi。
2. 如果 Kindle 刚重启，打开 **KUAL → Tesla: Start private SSH**。
   SSH 不会开机自启，这不影响独立运行的 Tesla 接收器。
3. 在 BWPC 的 PowerShell 执行：

```powershell
ssh -p 2222 -i "$HOME\.ssh\kindle-pw3-admin" `
  -o IdentitiesOnly=yes `
  -o HostKeyAlias=kindle-pw3-private `
  -o "UserKnownHostsFile=$HOME\.ssh\known_hosts_kindle_pw3" `
  -o StrictHostKeyChecking=yes `
  root@192.168.2.122
```

登录后可用 `uname -mr` 确认设备，用 `exit` 退出。维护结束后，可在
**KUAL → Tesla: Stop private SSH** 停止监听，不会停止 Tesla 接收器。

## 连不上时

- 超时：确认 Kindle 仍在线、SSH 菜单已启动，并检查路由器里 Kindle 的局域网
  地址和 BWPC 的当前地址。若 BWPC 地址改变，需要更新 Kindle 的 SSH 来源限制。
- `Permission denied (publickey)`：确认在 BWPC 上使用了命令指定的专用密钥。
  不要改成密码登录。
- 主机密钥不匹配：先通过可信方式核对 Kindle 的指纹，不要关闭
  `StrictHostKeyChecking`。

只在局域网使用 SSH。不要把 `2222` 转发到公网，也不要把 SSH 私钥提交到仓库。
公网 `4443` 仅用于 Tesla 遥测，与 SSH 无关。
