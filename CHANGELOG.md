# LazyCut 1.8.0 更新日志

## 1. 全新品牌升级：正式更名为 LazyCut
- **程序与安装包全面统一为 LazyCut**：主窗口标题栏、系统托盘菜单、桌面快捷方式、开始菜单入口、主程序 (`LazyCut.exe`)、卸载程序 (`卸载LazyCut.exe`) 与安装包 (`LazyCut-1.8.0-Windows-x64-Setup.exe`) 全部统一更名为 **LazyCut**，并无缝兼容老版本用户配置与素材目录。
- **官方仓库与自动更新源切换**：GitHub 仓库地址与在线自动更新源同步升级为 `https://github.com/Kirota233/LazyCut`。

## 2. 彻底修复「批量导出点击后鼠标不动也不点击」问题
- **移除阻塞导出的像素锚点与窗口句柄拦截检测**：彻底删除导出前循环 30 次（15 秒）比对标题/封面像素相似度的 `ResolveDraftPoint` (`WaitForDraftHome`) 检测、移除 `SafeClick` / `SafeDoubleClick` 在移动鼠标前的 `WindowFromPoint` 遮挡报错拦截、移除 `ClickButton` 的 10 次按钮图像模板匹配循环与 `WaitForExportDialogClosed` 阻塞等待，还原直接按坐标高速移动鼠标并点击的执行流程。
- **开始导出时自动收起置顶悬浮面板**：收到导出启动信号（`minimize`）时自动临时隐藏置顶悬浮窗面板，防止悬浮窗遮挡剪映草稿卡片或导出按钮，导出结束或中断后自动恢复面板显示。

## 3. 大幅提速「📸 截图识别」草稿扫描速度
- **去除开局 3 秒强制等待与冗余无损 PNG 编码**：移除截屏前 3 秒固定倒计时与无损全屏 PNG (`proofImage`) + 卡片锚点切片 (`RememberDraftAnchors`) 的冗余耗时操作，自动隐藏悬浮窗并置顶剪映后即刻截屏（1920px / JPEG 质量 82）。
- **两阶段扫描精简为单次 AI 全屏直出**：移除第一阶段「识别草稿标题分区（LocatePrompt / ParseScope）」与二次裁剪上传，改为单次视觉大模型请求直接返回全部草稿名称与点击坐标，扫描耗时缩短一半以上。
