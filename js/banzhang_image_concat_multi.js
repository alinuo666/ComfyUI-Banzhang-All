// 🧩 图像多路拼接 (Banzhang_ImageConcatMulti) 前端动态输入槽
// 复刻 KJNodes 的动态输入机制:根据「🔢 输入数量」增减 🖼️ 图像1..N 输入槽,
// 并提供「🔄 更新输入」按钮。未连线的槽位用空心点显示(shape: 7)。
const { app } = window.comfyAPI.app;

function bzSetupDynamicInputs(node, prefix, countWidget) {
    const rebuild = () => {
        if (!node.inputs) node.inputs = [];
        const countW = node.widgets?.find(w => w.name === countWidget);
        if (!countW) return;
        const target = countW.value;
        const current = node.inputs.filter(i => i.name?.startsWith(prefix)).length;
        if (target === current) return;
        if (target < current) {
            for (let i = 0; i < current - target; i++) node.removeInput(node.inputs.length - 1);
        } else {
            for (let i = current + 1; i <= target; i++) {
                node.addInput(`${prefix}${i}`, "IMAGE", { shape: 7 });
            }
        }
        node.setSize(node.computeSize());
    };
    node.addWidget("button", "🔄 更新输入", null, rebuild);
    const countW = node.widgets?.find(w => w.name === countWidget);
    if (countW) {
        const origCb = countW.callback;   // 可能不存在
        countW.callback = function (value, canvas) {
            const r = origCb ? origCb.apply(this, arguments) : undefined;
            if (!canvas) rebuild();   // 无画布参数 = 工作流载入,需恢复槽位;手动拖动不重建
            return r;
        };
    }
    return rebuild;
}

app.registerExtension({
    name: "Banzhang.ImageConcatMulti",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== "Banzhang_ImageConcatMulti") return;
        nodeType.prototype.onNodeCreated = function () {
            this._bzRebuildInputs = bzSetupDynamicInputs(this, "🖼️ 图像", "🔢 输入数量");
        };
        nodeType.prototype.onConfigure = function () {
            // 工作流载入后按保存的输入数量恢复槽位
            this._bzRebuildInputs?.();
        };
    },
});
