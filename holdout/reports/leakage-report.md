# 留出集防泄漏报告（holdout-lint v1）

- 时间(UTC)：2026-10-12T17:01:52.752Z
- 状态：checked｜开发语料 355 条
- 失败线/警告线：0.45 / 0.3（依据 holdout/spec.md §3）
- 结论：**通过**

## 逐条包含度（母语侧 vs 开发集，降序）

| pairId | family | tier | 同语言最相似 dev | 包含度 | 任意语言最相似 dev | 包含度 |
|---|---|---|---|---:|---|---:|
| HL-DE-01 | data_exfiltration | rewritten-hard | II-10 | 0.1311 | EV-53 | 0.1311 |
| HL-RP-05 | roleplay_jailbreak | new | RJ-05 | 0.1148 | RJ-05 | 0.1148 |
| HL-DE-05 | data_exfiltration | new | DE-02 | 0.1132 | EV-57 | 0.1509 |
| HL-DI-05 | direct_injection | new | EV-17 | 0.1111 | EV-17 | 0.1111 |
| HL-EN-05 | encoding_obfuscation | new | II-03 | 0.1111 | II-03 | 0.1111 |
| HL-DI-01 | direct_injection | rewritten-hard | DE-02 | 0.1094 | DE-02 | 0.1094 |
| HL-DE-02 | data_exfiltration | rewritten-hard | DE-08 | 0.0984 | DE-08 | 0.0984 |
| HL-DE-03 | data_exfiltration | new | II-02 | 0.098 | EV-07 | 0.1176 |
| HL-DI-02 | direct_injection | rewritten-hard | DI-03 | 0.0926 | EV-47 | 0.1296 |
| HL-RP-01 | roleplay_jailbreak | rewritten-hard | RJ-04 | 0.0909 | EV-34 | 0.1091 |
| HL-II-02 | indirect_injection | rewritten-hard | II-10 | 0.0862 | EV-53 | 0.0862 |
| HL-II-01 | indirect_injection | rewritten-hard | DE-05 | 0.0857 | EV-08 | 0.0857 |
| HL-MT-04 | multi_turn_induction | new | DE-02 | 0.0843 | EV-08 | 0.0964 |
| HL-DI-03 | direct_injection | rewritten-hard | EO-03 | 0.0816 | AG-10 | 0.0816 |
| HL-EN-03 | encoding_obfuscation | new | DI-08 | 0.0784 | RJ-MT-04 | 0.0784 |
| HL-RP-02 | roleplay_jailbreak | rewritten-hard | DI-01 | 0.0781 | EV-31 | 0.0938 |
| HL-II-03 | indirect_injection | rewritten-hard | DI-05 | 0.0741 | EV-53 | 0.0926 |
| HL-II-04 | indirect_injection | new | RJ-01 | 0.0741 | EV-38 | 0.0741 |
| HL-EN-01 | encoding_obfuscation | rewritten-hard | DI-08 | 0.0741 | DI-08 | 0.0741 |
| HL-MT-01 | multi_turn_induction | rewritten-hard | EV-18 | 0.0732 | EV-18 | 0.0732 |
| HL-DI-04 | direct_injection | new | MT-10 | 0.0652 | MT-10 | 0.0652 |
| HL-II-05 | indirect_injection | new | II-05 | 0.0635 | PC-02 | 0.0794 |
| HL-DE-04 | data_exfiltration | new | EV-13 | 0.0566 | BN-96 | 0.0755 |
| HL-RP-04 | roleplay_jailbreak | new | DI-09 | 0.0536 | BN-92 | 0.0536 |
| HL-RP-03 | roleplay_jailbreak | rewritten-hard | RJ-08 | 0.0492 | AG-20 | 0.0656 |
| HL-MT-05 | multi_turn_induction | new | RJ-01 | 0.0405 | EV-38 | 0.0541 |
| HL-MT-02 | multi_turn_induction | rewritten-hard | EV-18 | 0.0385 | EV-18 | 0.0385 |
| HL-EN-02 | encoding_obfuscation | rewritten-hard | DI-04 | 0.0323 | BN-08 | 0.0484 |
| HL-EN-04 | encoding_obfuscation | new | MT-10 | 0.025 | EV-53 | 0.0375 |
| HL-MT-03 | multi_turn_induction | new | RJ-01 | 0.0241 | BN-31 | 0.0361 |

## 违规
- 无

## 警告
- 无

## 说明
- 无
