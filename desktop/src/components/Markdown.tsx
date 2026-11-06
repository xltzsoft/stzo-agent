import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/native";

function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node === "object" && "props" in node) return textOf((node as any).props.children);
	return "";
}

function Pre({ children }: { children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	return (
		<pre>
			{children}
			<button
				className="btn small copy-code"
				onClick={() => {
					void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				}}
			>
				{copied ? "已复制" : "复制"}
			</button>
		</pre>
	);
}

const components = {
	pre: Pre,
	a: ({ href, children }: { href?: string; children?: ReactNode }) => (
		<a
			href={href}
			onClick={(e) => {
				e.preventDefault();
				if (href && /^https?:/.test(href)) void openExternal(href);
			}}
		>
			{children}
		</a>
	),
};

const plugins = [remarkGfm];
const rehype: any[] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	return (
		<div className={`prose selectable${streaming ? " caret-host" : ""}`}>
			<ReactMarkdown remarkPlugins={plugins} rehypePlugins={streaming ? [] : rehype} components={components as any}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
