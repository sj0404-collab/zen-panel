# OCR release reports

Every GitHub Actions APK candidate includes a Markdown quality report beside its APK artifact. The report records the source revision, remote build run, confirmed improvements, unresolved limitations, regression evidence, and the state of device validation.

The source files in this directory preserve the human-reviewed report for a candidate. The build workflow renders `OCR-QUALITY-REPORT-<full-commit>.md` from `CURRENT.md` and uploads it as a separate artifact only after the signed arm64 release APK has been built successfully. A report is therefore a transparent quality record, not a claim that OCR is complete.

| Candidate | Remote build | Device-validation status | Report |
|---|---:|---|---|
| `50a0c9e` | [32997836681][1] | Rejected: important clean Russian captions still failed | [2026-08-26-50a0c9e.md](2026-08-26-50a0c9e.md) |
| `9d19650` | [33002206845][2] | Partial improvement; further issues reported | [2026-08-26-9d19650.md](2026-08-26-9d19650.md) |
| `f6b4e01` | [33642798206][3] | Accepted for release: shipped as `v1.9.14`; device validation is the acceptance gate | [2026-08-26-f6b4e01.md](2026-08-26-f6b4e01.md) |

## References

[1]: https://github.com/sj0404-collab/yomihon-custom/actions/runs/32997836681 "GitHub Actions build 32997836681"
[2]: https://github.com/sj0404-collab/yomihon-custom/actions/runs/33002206845 "GitHub Actions build 33002206845"
[3]: https://github.com/sj0404-collab/yomihon-custom/actions/runs/33642798206 "GitHub Actions build 33642798206"
