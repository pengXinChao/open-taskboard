# Windows 测试签名

工作流 `.github/workflows/signpath-windows-test.yml` 仅由 `workflow_dispatch` 触发。
默认 `sign=false` 构建并上传未签名样本；`sign=true` 提交到 SignPath 测试策略并验证结果。
产物只保存在 Actions artifacts，保留 7 天。此流程不创建 Release、标签或更新产物。

## 构建与签名范围

流程复用 `npm run app:build:windows`，运行环境与现有 Windows CI 一致：
GitHub-hosted `windows-2025`、Node 22、Rust 1.88.0。
该命令通过 `scripts/prepare-tauri-app.mjs` 和 `scripts/tauri-build.mjs`，
按 `src-tauri/tauri.windows.conf.json` 生成 NSIS 安装程序。

| 构建文件（相对于 `src-tauri/target/x86_64-pc-windows-msvc/release/`） | ZIP 根目录文件 |
| --- | --- |
| `codex-taskboard-launcher.exe` | `codex-taskboard-launcher.exe` |
| `bundle/nsis/*-setup.exe`（必须恰好一个） | `codex-taskboard-test-setup.exe` |

只复制这两个文件到专用暂存目录。`upload-artifact` 创建一层 ZIP，不预先压缩。
原始路径、提交、运行编号和未签名文件 SHA-256 写入 `unsigned-sample.json`。

SignPath 的 [PE 类型不是复合格式](https://docs.signpath.io/artifact-configuration/reference)，
官方格式表未列出 NSIS 深层签名。因此本流程签独立 launcher 副本和安装程序外层。
独立签好的 launcher 不会重新放入安装程序。安装程序内部的 launcher、卸载器及第三方
Node 不因此获得新签名。独立 launcher 也不是包含完整资源的便携应用。

## SignPath 配置

| 字段 | 值 |
| --- | --- |
| Organization ID | `8322a055-0327-41ec-a602-736063510184` |
| Project slug | `dashi-taskboard` |
| Signing policy slug | `test-signing` |
| Artifact configuration slug | `windows-test-zip` |
| Artifact configuration XML | [`.signpath/windows-test-zip.xml`](../.signpath/windows-test-zip.xml) |

在项目中新增 `windows-test-zip` 配置，粘贴 XML 并保存验证。保留现有默认单 PE 配置。
工作流显式指定新 slug；本地 XML 不会自动上传到 SignPath。

确认 `test-signing` 绑定预期的有效测试证书，CI builds 对此项目和策略具有 submitter 权限。
token 不需要正式签名权限。按 [GitHub 集成文档](https://docs.signpath.io/trusted-build-systems/github)
确认项目已关联 GitHub.com Trusted Build System；审计日志评估要求 SignPath GitHub App
具有仓库访问权限。不要更改现有审批或来源限制来跳过失败。

## GitHub 配置

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Repository secret | `SIGNPATH_API_TOKEN` | CI submitter 的 SignPath token |
| Repository variable | `SIGNPATH_TEST_CERTIFICATE_SHA256` | 测试签名叶证书 DER SHA-256，64 位十六进制，无空格或冒号 |

从 SignPath 中 `test-signing` 实际绑定的证书导出不含私钥的公开 `.cer`，确认其身份、有效期和
Code Signing EKU。此路径用于 SignPath 自签名测试证书，不自动导入未知 CA 链。
用 PowerShell 7 读取公开证书及其 DER 指纹：

```powershell
$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    (Resolve-Path -LiteralPath './signpath-test.cer').Path
)
$cert | Format-List Subject, Issuer, SerialNumber, NotBefore, NotAfter, EnhancedKeyUsageList
$cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
```

此命令不改变证书信任。不要使用通常为 SHA-1 的 `.Thumbprint`、EXE 哈希或 ZIP 哈希。
不要从返回产物反推预期指纹。预期值必须先从可信账户配置独立确认。
无需 PFX、私钥或额外证书 Secret。

## 首次运行

GitHub 要求新的手动工作流先存在于[默认分支](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。
仅指定功能分支 `--ref` 不能绕过首次可用性限制。合并前可审查新增文件、运行静态解析，
并用现有 PR CI 验证原 Windows 构建；这不代表新签名流程已执行。

默认分支包含工作流后，在 Actions 选择 **SignPath Windows test** 和获批分支，先不勾选 `sign`：

```sh
gh workflow run signpath-windows-test.yml --repo chuspeeism/dashi-taskboard --ref <approved-branch> -f sign=false
```

这会重建并生成可重现的未签名样本，不需要 token、指纹或 SignPath ZIP 配置。
下载 `signpath-windows-test-unsigned-<run_id>-<run_attempt>`，确认 ZIP 根目录只有上表两个文件，
并与 `signpath-windows-test-evidence-<run_id>-<run_attempt>` 中的清单核对哈希。
该 ZIP 可用于账户侧检查产物配置。

完成账户与 GitHub 配置，并获得下节所述机器级临时信任的明确授权后，再运行：

```sh
gh workflow run signpath-windows-test.yml --repo chuspeeism/dashi-taskboard --ref <approved-branch> -f sign=true
```

请求通过 `signpath/github-action-submit-signing-request@v3` 提交刚上传的 artifact ID，
固定使用 `test-signing` 和 `windows-test-zip`，等待最多 1200 秒并下载结果。
缺失配置或签名失败时，已成功上传的未签名样本仍保留。

## 验证结果

`scripts/verify-signpath-windows-test.ps1` 先检查两个返回文件和签名叶证书 SHA-256，
再仅在一次性 GitHub-hosted Windows runner 的 `LocalMachine/Root` 暂时信任该公开证书。
这是该 VM 的机器级信任，对该机所有用户可用，不是只作用于验签进程；必须单独授权，
此前的 `CurrentUser/Root` 或 NO_UI 授权不覆盖此范围。本次已确认的公开证书 DER SHA-256 为
`1C1CF94CBE6DE16C359FE49BC3900FFCA04FEF68369E4EA597164A97222CA733`；
现有 `SIGNPATH_TEST_CERTIFICATE_SHA256` 变量须保持该独立确认值，换证书需重新确认。

导入使用 `Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\LocalMachine\Root'`，
依据 [SignPath 的脚本示例](https://signpath.io/knowledge-base/test-certificates#using-scripts-and-batch-files)
和 [Microsoft Import-Certificate Example 3](https://learn.microsoft.com/en-us/powershell/module/pki/import-certificate#example-3)。
系统库写入要求管理员权限；[GitHub 的 Windows hosted VM](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)
默认以管理员运行且 UAC 已禁用。这是平台配置说明，本脚本不提权、不改 UAC 或保护策略，
不抑制或自动点击安全提示。官方示例不代替本 runner 上的真实验证；失败不切换库或放宽验签。

先检查同一 `Cert:\LocalMachine\Root\<thumbprint>` 路径；已有证书不重导入、不删除。
仅在该路径原先不存在时导入，`finally` 用 `Remove-Item -LiteralPath $storePath` 移除本次新增信任。
不修改开发者、最终用户或自托管 runner 的信任库；Mac 只做文件审查，不执行信任导入。
强制终止可能跳过清理，因此只允许一次性 hosted runner；没有清理证据不能宣称已移除。

两个 PE 都必须通过 `signtool verify /pa /all /v`，退出码为 0；随后
`Get-AuthenticodeSignature` 必须返回嵌入式 `Authenticode`、`Valid` 和匹配的证书指纹。
`NotTrusted`、`UnknownError`、`HashMismatch` 或仅有指纹匹配都不代表完整性验证成功。
只有验签成功才上传 `signpath-windows-test-signed-<run_id>-<run_attempt>`。

核对 Actions 摘要的提交、artifact ID、SignPath request ID 及步骤结果；在 SignPath 核对
项目、策略、配置、证书和 GitHub 构建来源。证据 artifact 包含：

- `unsigned-sample.json`：源路径和未签名文件哈希。
- `verification.json`：`verified: true`、两项 `signtool_exit_code: 0`、两项 `Valid` 和预期指纹。
- 两个 `*.signtool.txt`：Windows 验证日志。
- `test-signer.cer`：已核对身份的公开证书。

直接路径的 UTC 导入、验签和清理日志在 Actions job log 中；不再运行 P/Invoke 或窗口观察器。
报告的 `trust_scope` 应为 `LocalMachine/Root`；本次实际新增时，核对 `temporary_trust_removed: true`。
若导入前证书已存在，该字段为 false，表示没有移除既有信任，不应据此删除它。
进入临时信任阶段后，验证失败也会写报告；文件集合或身份预检查失败可能只有步骤错误日志。
准备模式的绿色结果不能当作签名通过。普通工作站无需导入测试根证书；下载后可比对证据哈希，
完整性结论以一次性 runner 的验证记录为准。测试结果不证明安装、更新、内部签名或公开信任。

静态解析和现有 PR CI 不覆盖 SignPath 服务端 XML 校验、真实请求及 Windows 验签。
这些步骤必须在账户配置和默认分支集成后完成并记录真实运行链接。
