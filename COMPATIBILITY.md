# 兼容与恢复验收记录

## 0.5.3 范围

增加脱敏的网络错误证据：原始错误码、请求持续时间、请求体发送完成时间、是否收到响应、交给请求流的字节数与连接复用情况。修复原始请求错误被连带流关闭错误掩盖的情况。保持原有超时、单次PUT和无自动重传，不声称Koofr大文件中断已解决。

2026-11-17：用户Koofr小备份1,252,448字节，11秒完成且远端大小一致；大备份交给流141,377,967字节后约115秒ECONNRESET。没有证据确定断开方或远端已接收字节。原版客户端在本机HTTPS连续流式上传126.3秒成功，不能将120秒空闲时限解释成固定总时限。33项回归与2项网络测试通过。

参考 [ST-pack-transfer 722b295 的传输执行器](https://github.com/jiozhaoyue/ST-pack-transfer/blob/722b295fe02d0d41bbae261d03e02dbd1690a00f/src/app/transfer-runner.js)：默认8MiB独立分片、HEAD存在跳过、清单重组。该方案改变云端存储形式并依赖可重复读取的源Blob，不是对单ZIP PUT的直接替换；本版未加入分片或续传。


仅保留 HTTPS + Basic 认证的流式上传。服务需要 PROPFIND、未知长度 PUT、MOVE；缺失目录需要 MKCOL。要求 Content-Length 的服务不支持，HTTP 411 应明确报错且不自动重放写入。

针对用户实际遇到的其他WebDAV服务问题继续排查，不限定于坚果云。兼容上传在 Android 的暂存目录/权限问题后被删除，旧版本模拟测试通过不代表该功能在 Android 已验证。

## 已有验证

| 对象 | 已有证据 | 边界 |
| --- | --- | --- |
| 坚果云 | 用户确认流式备份、大小核对、列表、建目录、弹窗；0.5.0 设置项流式备份生成 | 不等于已完成全部分类恢复 |
| 本机 HTTPS 测试服务 | 合成归档与真实 socket，拒绝未知长度时验证失败行为 | 测试替身，不算真实网盘 |
| WsgiDAV 4.4.1 / Cheroot 11.1.2 | 已有独立服务端测试，保留流式流程、编码目录、MOVE、列表、下载哈希 | 不代表所有 WebDAV 服务 |
| Luker 恢复规则 | 固定提交的选择与路径函数测试 | 不启动完整 Luker，不执行真实恢复 |

## third-party 恢复问题

固定源码：[Luker edae4ef84adde5a78c443883c224ef5753f81975](https://github.com/funnycups/Luker/tree/edae4ef84adde5a78c443883c224ef5753f81975)。

- 前端默认 `globalExtensions: false`。
- 恢复路由按提交的 selection 和管理员身份计算允许目录，不自动因为 ZIP 内有文件就选中分类。
- `third-party/JS-Slash-Runner/...` 是全局**前端**扩展。插件服务端代码不是该分类，需单独安装。
- `path_not_in_selected_categories` 在条目无法映射到本次允许目标时产生；不等于 CRC 错误，也不是 `.git` 文件被统一禁止。
- 用户确认使用“备份恢复”，但全局扩展未勾或不确定；后来确认原生 ZIP 恢复也未恢复相关扩展。应先核对分类和术语，不能归因为 WebDAV 导出损坏。

只读规则测试对用户列出的 12 个路径验证：

| 恢复选择 | 管理员 | 规则结果 |
| --- | --- | --- |
| 用户扩展开，全局扩展关 | 是 | 12 个路径全部不在允许范围 |
| 用户扩展开，全局扩展开 | 是 | 12 个路径全部映射到全局扩展目录 |
| 用户扩展开，全局扩展开 | 否 | 全局分类被去除，12 个路径不在允许范围 |

另外，在仅选全局分类时检查四个全局目录别名和宿主生成的归档前缀。注意 `extensions/third-party` 与用户扩展路径可能重叠，当前源码直接目录匹配优先于别名匹配；此问题与本次根级 `third-party` 路径不同，不通过重命名 ZIP 绕过。

结果证据来源为从固定提交下载的公开源码，测试执行其原有函数，没有重新实现分类规则。三个源文件 SHA-256：

```text
src/users.js
 ae8c1b1f954751e2a43096fc41f88bb96c50668006f60bd5bc5cdf144d407528
src/endpoints/users-private.js
 774fac81fcb4fd8754bb294db50d7fe270a1e0510bae4a17624d98b2ad3d5830
public/scripts/user.js
 ee4b8cbf2061ebce94301bd621ca272c46a1146c9d07f6658bfbbfcaf9a711f5
```

用户于2026-11-17在此前恢复操作说明后确认“实验已无问题”，本次实际恢复验收按用户反馈通过；未取得逐项恢复日志，不能扩展成所有宿主版本和备份组合的保证。

## 复现命令

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:network
node tests/run-restore-path-check.mjs
```

最后一项联网获取固定提交的三个源码文件；传入该提交本地源码目录可离线运行。只分析函数和合成路径，不恢复用户文件。

已有独立服务端测试：

```sh
python3 -m venv .venv-webdav
.venv-webdav/bin/python -m pip install -r tests/requirements-webdav.txt
WEBDAV_TEST_PYTHON=.venv-webdav/bin/python npm run test:interop
```

网络测试只监听 loopback 随机端口，使用合成 ZIP/账号和临时证书，通过测试子进程的 NODE_EXTRA_CA_CERTS 信任它，不改变生产 TLS。结束后关闭进程并清理此次创建的文件。

## 历史参考

曾对照 [RikkaHub a75f3f9](https://github.com/rikkahub/rikkahub/tree/a75f3f9cd7863bf571642044112e9bf443263f73)、[rclone b0ef5f6](https://github.com/rclone/rclone/blob/b0ef5f6a6eca641a6bfb55bc05ef1595f4105d07/backend/webdav/webdav.go) 和 [webdav-client ab039cb](https://github.com/perry-mitchell/webdav-client/blob/ab039cb8d793d03a6b1c15c80b650d9e9d727679/source/operations/putFileContents.ts)。本版保留失败处理、结果核验的改进，删除本地 ZIP 暂存方案，归档格式和恢复权限继续由 Luker 管理。
