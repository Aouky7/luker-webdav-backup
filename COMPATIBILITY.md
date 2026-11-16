# WebDAV 兼容性与参考记录

## 0.5.0 的适用条件

两种上传模式均使用 HTTPS + Basic 认证（服务商要求时填写应用密码），并依赖 PROPFIND、PUT 和 MOVE。自动补建目录还需要 MKCOL；已有目录不需要创建权限。HEAD 仅作为大小查询的后备方式。

- **流式上传**：Luker 生成 ZIP 的同时上传，服务及代理必须接受未知长度的 HTTP/1.1 请求体。
- **兼容上传**：先在后端本地生成 ZIP，再以明确的 Content-Length 从磁盘流式上传。可以解决要求已知上传长度的问题，但不能绕过配额、权限、代理大小限制或缺失的 MOVE 支持。

本版没有自动重定向、Digest/Token 认证、Nextcloud 专用分片、断点续传或自动重试写入。必须填写最终 WebDAV 目录地址。凭据不随错误信息返回；不关闭 TLS 证书验证。

## 验证级别

| 对象 | 证据类型 | 已知范围 |
| --- | --- | --- |
| 坚果云 | 用户真实账号验证，0.3.0/0.4.0 | 流式上传、云端列表、大小核对；0.4.0 自动建目录和手机弹窗由用户确认正常 |
| 严格长度 HTTPS 测试服务 | 本仓库可重复协议测试 | 拒绝未知长度 PUT；验证兼容模式请求头、实际字节、改名和下载哈希；属于测试替身，不算真实网盘验证 |
| WsgiDAV 4.4.1 / Cheroot 11.1.2 | 独立服务端互操作测试 | 使用合成 ZIP、测试账号与本机 HTTPS；验证两种模式、中文/空格多层目录、改名、列表和下载哈希；执行结果以测试报告为准 |
| Nextcloud | 官方文档及客户端源码匹配 | 标准用户文件端点的方法匹配；本版尚无真实 Nextcloud 实例测试 |
| InfiniCLOUD | 官方方法说明匹配 | 文档支持所需方法；本版尚无真实账号测试 |
| Koofr / AList / NAS | 待验证 | 认证、驱动、权限和代理配置需逐一验证；不统一宣称兼容 |

坚果云旧版验证不能替代 0.5.0 新增暂存上传的实测。独立服务端通过也不代表所有网盘通过。

2026-11-16 本机验收：Node.js v24.22.1 / Python 3.12，33 项回归与前端测试通过；真实 HTTPS 严格长度测试、WsgiDAV 4.4.1 / Cheroot 11.1.2 独立服务端互操作共 2 项通过，均无跳过。两种模式下载后的合成 ZIP 与源字节 SHA-256 一致。Node.js 22 的结果以发布后的 GitHub Actions 为准。

## 参考源码与取舍

- [RikkaHub a75f3f9](https://github.com/rikkahub/rikkahub/tree/a75f3f9cd7863bf571642044112e9bf443263f73)：参考其本地生成 ZIP、从磁盘读取并设置长度的设计。保留本插件已有 .partial → MOVE 和上传后大小核对。Luker 的归档与恢复继续由宿主管理，不照搬 RikkaHub 数据库恢复代码。
- [rclone b0ef5f6](https://github.com/rclone/rclone/blob/b0ef5f6a6eca641a6bfb55bc05ef1595f4105d07/backend/webdav/webdav.go)：参考定长请求、上传后读取元数据，以及按服务能力适配的做法。未移植服务商专用认证、自动重试/删除或 Nextcloud 分片。
- [webdav-client ab039cb](https://github.com/perry-mitchell/webdav-client/blob/ab039cb8d793d03a6b1c15c80b650d9e9d727679/source/operations/putFileContents.ts)：该版本对 Node Readable 分支跳过自动设置 Content-Length，不能只凭文档参数推断线上请求。当前保留内置 HTTPS 实现，用真实请求测试验证长度；未引入生产运行依赖。

以上是设计参考，不是完整代码审计或这些项目的服务兼容保证。

## 复现实验

在仓库根目录：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:network
```

独立服务端需 Python 3.12、OpenSSL 与测试专用依赖：

```sh
python3 -m venv .venv-webdav
.venv-webdav/bin/python -m pip install -r tests/requirements-webdav.txt
WEBDAV_TEST_PYTHON=.venv-webdav/bin/python npm run test:interop
```

运行器临时生成证书，仅通过该测试 Node 子进程的 NODE_EXTRA_CA_CERTS 信任它；不改变生产 TLS。服务只监听本机随机端口，结束时关闭进程并清理此次创建的存储和证书目录。所有 ZIP 和账号均为合成测试数据。独立服务端只安装在开发/CI 环境。

## 新服务的人工验收步骤

1. 使用私有测试目录与专用账号，填写服务的最终 HTTPS WebDAV 地址。
2. 指定一个尚不存在的多层目录，测试连接后确认目录已创建。
3. 分别选择两种模式完成一次小备份，确认任务结果、大小核对和云端列表。
4. 在测试环境下载文件，对比源文件哈希；实际用户备份可做 ZIP CRC/结构检查，再在独立 Luker 环境恢复演练。
5. 对较大备份重复验证，记录服务版本、代理限制、上传模式和实际字节数。
6. 将成功、失败和未测项分开记录，避免将“连接成功”视为“上传及恢复已验证”。

本插件日常核验仅比较大小。互操作测试中的下载 SHA-256 校验属于测试功能，不表示产品增加了下载或内容校验接口。
