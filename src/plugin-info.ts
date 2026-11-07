/** Bundled plugin catalogue (kept free of heavy imports so the CLI and desktop can read it cheaply). */
export interface PluginInfo {
	name: string;
	title: string;
	description: string;
	defaultEnabled: boolean;
}

export const PLUGIN_INFO: PluginInfo[] = [
	{ name: "plan-mode", title: "规划模式", description: "/plan 进入只读模式：先分析代码、列出步骤，确认后再动手", defaultEnabled: true },
	{ name: "todo", title: "待办清单", description: "模型自己维护任务清单，/todos 查看进度", defaultEnabled: true },
	{ name: "subagent", title: "子代理", description: "把调研、规划、实现、审查交给独立的子代理并行处理", defaultEnabled: true },
	{ name: "question", title: "提问", description: "需要你拍板时，模型会弹出选项让你选", defaultEnabled: true },
	{ name: "handoff", title: "会话交接", description: "/handoff 把当前进展总结后转到新会话继续", defaultEnabled: true },
	{ name: "session-name", title: "会话命名", description: "根据第一条消息自动给会话起名", defaultEnabled: true },
	{ name: "confirm-destructive", title: "危险操作确认", description: "在终端里新建、切换或分叉会话前先问你（桌面版不询问）", defaultEnabled: true },
	{ name: "protected-paths", title: "受保护路径", description: "禁止改写 .env、.git、node_modules 等文件", defaultEnabled: true },
	{ name: "notify", title: "完成提醒", description: "任务完成时发系统通知", defaultEnabled: true },
	{ name: "git-checkpoint", title: "Git 检查点", description: "每轮对话自动 git stash 快照，便于回滚（会产生额外 stash）", defaultEnabled: false },
];
