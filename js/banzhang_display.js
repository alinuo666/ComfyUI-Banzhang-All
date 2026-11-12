import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// 在浏览器控制台打印日志
console.log("👨‍🏫 班长前端脚本 (双屏版) 已加载！");

app.registerExtension({
	name: "BanZhang.TextExtractor",
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name === "BanZhang_Text_Range_Extractor") {
			
			const onExecuted = nodeType.prototype.onExecuted;

			nodeType.prototype.onExecuted = function (message) {
				onExecuted?.apply(this, arguments);

                // 检查是否收到了包含两个文本部分的 UI 消息
				if (message && message.text && message.text.length >= 2) {
					const result_text = message.text[0];   // 提取结果 / 警告信息
                    const original_text = message.text[1]; // 原始文档内容
                    
                    // --- 区域 1：提取结果显示框 ---
                    this.updateWidget("custom_result_box", result_text, "#222", "✂️ 结果/警告");

                    // --- 区域 2：原始文档显示框 ---
                    this.updateWidget("custom_original_box", original_text, "#111", "📄 原始文档");
                    
                    // 强制刷新节点大小
					this.onResize?.(this.size);
				}
			};

            // 封装一个更新/创建控件的辅助函数
            nodeType.prototype.updateWidget = function(widgetName, textValue, bgColor, defaultLabel) {
                let widget = this.widgets?.find((w) => w.name === widgetName);
                
                if (!widget) {
                    try {
                        // 创建多行文本框
                        // 注意：这里我们借用 STRING 类型，但设置 multiline
                        const w = ComfyWidgets["STRING"](this, widgetName, ["STRING", { multiline: true }], app).widget;
                        
                        // 设置只读
                        w.inputEl.readOnly = true;
                        // 设置样式
                        w.inputEl.style.opacity = 0.7;
                        w.inputEl.style.backgroundColor = bgColor; 
                        w.inputEl.placeholder = defaultLabel;
                        
                        // 赋值
                        w.value = textValue;
                    } catch (e) {
                        console.error("👨‍🏫 [错误] 创建文本框失败:", e);
                    }
                } else {
                    // 已存在则直接更新
                    widget.value = textValue;
                }
            };
		}
	},
});