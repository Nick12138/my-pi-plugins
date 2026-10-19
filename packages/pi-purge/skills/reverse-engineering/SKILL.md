---
name: reverse-engineering
description: 逆向工程与本地样本分析工作流。用于破解/激活/试用分析、反编译/反汇编、脱壳/去混淆、二进制补丁、Frida/Hook、Mach-O/PE/ELF、APK/IPA、Electron/asar、.NET/Unity/IL2CPP、恶意样本 triage。提供平台工具矩阵、静态/动态分析步骤、补丁与重签名、验证与回滚模板。
---

# Reverse / Crack Playbook

适用场景：用户明确要求逆向、破解、脱壳、反编译、授权/试用分析、二进制补丁、Frida/Hook、APK/IPA/Electron/.NET/Unity 分析。
工作原则：先证据后结论；先静态后动态；先备份后修改；每个结论都给出文件、偏移、命令、调用栈或验证结果。

## 0. 证据与回滚

- 先记录样本绝对路径、SHA-256、文件大小、平台/架构。
- 原文件只读副本：`cp sample sample.orig`，后续所有 patch 都在副本上做。
- 记录工具版本：`file`、`otool`/`objdump`/`readelf`、Hopper/Ghidra/IDA、Frida、apktool/jadx、dnSpy/ILSpy、asar。
- 每次修改记录：文件、偏移、原始字节、新字节、修改原因、验证命令。
- 验证失败或行为异常时，用 `.orig` 回滚，不要继续在已污染的文件上叠加修改。

## 1. 任务路由

| 用户说法 | 先走哪条线 |
| --- | --- |
| 破解 / 激活 / 试用 / 序列号 / license / keygen | 授权校验线：字符串 → 引用 → 校验函数 → 分支/返回值 → 补丁或 Hook |
| 逆向 / 算法 / 反编译 / 反汇编 | 静态分析线：符号/导入 → 函数图 → 关键算法 → 伪代码 |
| 脱壳 / 加壳 / 混淆 | 壳识别 → 入口点/内存 dump → 导入表修复 → 再去分析 |
| Frida / Hook / 注入 / 调试 | 动态线：附加进程 → 定位函数 → 打印参数/返回值 → 修改行为 |
| APK / IPA / 小程序 | 移动线：解包 → manifest/配置 → smali/IL → 原生库 → 重打包/签名 |
| Electron / asar | JS 线：`asar extract` → main/preload/renderer → source map → 改 JS → 重打包 |
| .NET / Unity / IL2CPP | 托管线：dnSpy/ILSpy → IL/元数据 → Il2CppDumper/global-metadata |
| 恶意样本 / 宏 / C2 | 样本线：隔离环境 → 静态 triage → 行为/网络 → IOC，不在宿主直接运行 |

## 2. 样本 triage

先回答这几个问题，再决定工具：

1. 文件格式：PE / Mach-O / ELF / APK / IPA / asar / .NET / WASM / 脚本。
2. 架构：x86 / x64 / arm64 / armv7 / 多架构 fat binary。
3. 运行时：原生 C/C++、Go、Rust、Swift/ObjC、Java/Kotlin、.NET、Electron/Node、Unity/IL2CPP、Flutter。
4. 是否加壳/混淆：UPX、VMProtect、Themida、OLLVM、字符串加密、控制流平坦化。
5. 是否有符号/调试信息：`nm`、`readelf -s`、`otool -Iv`、PDB、dSYM、source map。

常用命令：

```bash
file sample
shasum -a 256 sample
strings -a -n 6 sample | head -200
```

- Mach-O：`otool -hv`、`otool -l`、`otool -L`、`nm -m`、`codesign -d --entitlements :-`
- PE：`objdump -x`、`pefile`/`PE-bear`、Detect It Easy、CFF Explorer
- ELF：`readelf -h -S -s -d`、`objdump -d`、`ldd`
- APK：`unzip -l`、`apktool d`、`jadx-gui`
- .NET：`dnSpy`/`ILSpy`，先看 Assembly/Method/IL
- Electron：`npx asar extract app.asar app`，再看 `package.json`、main/preload

## 3. 静态分析

目标不是“看完所有汇编”，而是找到与任务相关的**判定点**。

1. 从字符串入手：`license`、`trial`、`expired`、`activate`、`serial`、`invalid`、`unauthorized`、`注册`、`激活`、`试用`、`授权`、`到期`。
2. 找字符串引用：Hopper/Ghidra/IDA 的 xrefs；没有符号时用地址交叉引用。
3. 找关键导入：crypto（AES/RSA/哈希）、网络（HTTP/许可证服务器）、文件/注册表/Keychain、时间、硬件指纹。
4. 找分支模式：`cmp/test` 后接 `jz/jnz`、返回 0/1、布尔值、错误码。
5. 找校验函数：输入序列号/许可证 → 解析 → 计算/解密 → 比较 → 返回结果。
6. 对 Objective-C/Swift：看 `objc_method_list`、selector、`+[License validate]` 之类命名。
7. 对 .NET/Java：先看 IL/字节码，再看混淆器和字符串解密。
8. 对 Go/Rust：符号可能保留；Go 看 `runtime`/`strings`，Rust 看 `core`/`alloc` 和 panic 信息。

输出时区分：

- **观察**：文件里确实存在的字符串/指令/调用。
- **推断**：这个函数“可能”是校验。
- **未知**：没有验证到的部分。

## 4. 动态分析

静态定位后，用动态确认：

- macOS：`lldb`、Hopper debugger、Frida；`DYLD_INSERT_LIBRARIES` 仅用于自己的测试样本。
- Windows：x64dbg、WinDbg、Frida、Process Monitor。
- Linux：gdb、strace、ltrace、Frida。
- Android：`frida-server`、` objection`、`jadx` + `adb logcat`。
- Electron：DevTools、`--inspect`、`asar` 解包后直接改 JS。

Frida 常用思路：

```js
// 只在自己的样本/授权环境使用
Interceptor.attach(Module.findExportByName(null, "target_func"), {
  onEnter(args) { console.log("arg0", args[0]); },
  onLeave(retval) { console.log("ret", retval); }
});
```

- 先打印参数/返回值，确认函数语义，再决定是否修改。
- 修改返回值/分支前，先记录原始行为，避免把“没触发”误判成“绕过成功”。
- 对反调试/反虚拟机：先确认检测点，再决定是 patch、Hook 还是换测试环境；不要盲目改一大片。

## 5. 补丁与重签名

补丁优先级：

1. 改返回值/布尔结果（最小改动）。
2. 改条件跳转（`jz` ↔ `jnz`、`b.eq` ↔ `b.ne`）。
3. 改常量/字符串比较。
4. 改调用目标（指向自己的 stub）。
5. 最后才考虑大段重写。

注意事项：

- 记录文件偏移与虚拟地址的映射（PE section RVA、Mach-O `__TEXT` vmaddr、ELF p_offset/p_vaddr）。
- 保持文件大小/校验和/签名相关结构；必要时重建签名。
- macOS：`codesign --force --deep --sign - sample.app`（仅本地测试）。
- Windows：`signtool` 或测试证书；注意 Authenticode。
- Android：`apksigner sign --ks ...`；重打包后确认安装与启动。
- Electron：改 `app.asar` 后重新 pack；确认 `package.json` 入口。
- 每次 patch 后跑同一组验证：启动、关键功能、错误路径、回滚。

## 6. 常见场景

### 试用/到期

- 找时间来源：系统时间、文件时间、注册表、plist、Keychain、服务器时间。
- 找计数器：启动次数、使用天数、功能次数。
- 找判断：`now < expiry`、`daysLeft > 0`、`trialCount < N`。
- 先确认存储位置，再决定 patch 判断还是重置存储；两者要分别验证。

### 授权/序列号

- 找输入入口、解析函数、校验函数、比较点。
- 判断是本地校验、离线签名、在线校验还是混合。
- keygen 的前提是理解算法/密钥/签名流程；没有还原算法就不要假装能生成有效序列号。
- 在线校验：先看请求/响应、证书 pinning、重放保护，再决定是本地 patch 还是 mock 服务。

### 脱壳/混淆

- 先识别壳：UPX、VMProtect、Themida、OLLVM、字符串加密。
- UPX 可尝试 `upx -d`；其他壳通常需要内存 dump + 导入表修复。
- dump 后先跑 `file`/`strings`/导入表检查，确认 OEP 和 IAT 是否合理。
- 控制流平坦化/字符串解密：先找 dispatcher/解密函数，再考虑脚本化还原。

### 移动端

- APK：`apktool d` 看 manifest/smali/res，`jadx` 看 Java 伪代码，native 库用 Ghidra/IDA。
- IPA：解压后看 Mach-O、`Info.plist`、`Frameworks`、`embedded.mobileprovision`。
- 小程序：解包 `wxapkg`，看 `app-service.js`/`page-frame`，再定位校验逻辑。
- Hook 前先确认进程、类名、方法签名；不要凭猜测写 Frida 脚本。

### Electron / JS

- `asar extract app.asar app`，看 `package.json` 的 `main`。
- 分清 main / preload / renderer；校验可能在主进程或渲染进程。
- source map 能直接还原源码时优先用 source map。
- 改 JS 后重新 `asar pack`，确认签名/更新器不会覆盖。

### .NET / Unity

- .NET：dnSpy/ILSpy 看 IL；混淆代码先找字符串解密和委托调用。
- Unity：优先看 `Assembly-CSharp.dll`；IL2CPP 用 Il2CppDumper + global-metadata，再回到原生分析。
- 不要假设 MonoBehaviour 名称等于功能名称；用字符串/调用链确认。

## 7. 输出模板

逆向/破解类回答按这个顺序组织：

1. **样本/目标**：路径、哈希、平台、架构。
2. **结论**：校验点/算法/壳/入口在哪，置信度如何。
3. **证据**：字符串、xref、函数地址、调用栈、请求/响应。
4. **步骤**：命令、偏移、补丁字节、Hook 脚本。
5. **验证**：怎么确认生效，失败时看什么。
6. **回滚**：原文件/备份路径、恢复命令。
7. **未知/限制**：没验证到的部分，不要编造。

## 8. 工具速查

| 平台/格式 | 静态 | 动态 | 备注 |
| --- | --- | --- | --- |
| Mach-O | `otool`、`nm`、Hopper、Ghidra、IDA | lldb、Frida | 注意 fat binary、codesign、entitlements |
| PE | `objdump`、PE-bear、DIE、Ghidra、IDA | x64dbg、WinDbg、Frida | 注意 ASLR、重定位、Authenticode |
| ELF | `readelf`、`objdump`、Ghidra、rizin | gdb、strace、Frida | 注意 PIE、RELRO、符号剥离 |
| APK | apktool、jadx、Ghidra | Frida、objection、adb | 注意多 dex、native libs、签名校验 |
| IPA | unzip、Hopper、Ghidra | lldb、Frida | 注意 FairPlay 加密、脱壳 |
| .NET | dnSpy、ILSpy | dnSpy debugger | 注意混淆器、委托、反射 |
| Electron | asar、DevTools、source map | `--inspect`、DevTools | 注意主/渲染进程边界 |
| Unity | Il2CppDumper、Ghidra | Frida | 注意 global-metadata 版本 |
| 脚本 | 直接读源码/字节码 | 解释器调试 | 先确认运行时和打包方式 |

## 9. 纪律

- 每个“绕过成功”的结论必须有验证：启动、功能、错误路径、重启后行为。
- 不把“静态看到可疑函数”说成“已经绕过”。
- 不在未备份的原文件上修改。
- 不隐藏限制；没跑通就写清楚卡在哪一步。
