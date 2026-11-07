// Minimal stroke icon set (1.6px strokes, 16px grid) so the app ships no icon font.
import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({
	width: 16,
	height: 16,
	viewBox: "0 0 16 16",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.6,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
	"aria-hidden": true,
	...p,
});

export const IconSend = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
	</svg>
);
export const IconStop = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
	</svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M8 3v10M3 8h10" />
	</svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="m4.5 6 3.5 3.5L11.5 6" />
	</svg>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="m6 4.5 3.5 3.5L6 11.5" />
	</svg>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="m3.5 8.5 3 3 6-7" />
	</svg>
);
export const IconGear = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<circle cx="8" cy="8" r="2" />
		<path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
	</svg>
);
export const IconSidebar = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<rect x="2" y="2.5" width="12" height="11" rx="2" />
		<path d="M6 2.5v11" />
	</svg>
);
export const IconFolder = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.5h5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" />
	</svg>
);
export const IconImage = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<rect x="2" y="2.5" width="12" height="11" rx="2" />
		<circle cx="6" cy="6.5" r="1.2" />
		<path d="m2.5 12 3.5-3.5 3 3 2-2 2.5 2.5" />
	</svg>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="m4 4 8 8M12 4l-8 8" />
	</svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
		<path d="M11 5V3.5c0-.8-.7-1.5-1.5-1.5h-6C2.7 2 2 2.7 2 3.5v6c0 .8.7 1.5 1.5 1.5H5" />
	</svg>
);
export const IconSpark = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12" />
	</svg>
);
export const IconWallet = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<rect x="2" y="3.5" width="12" height="9.5" rx="2" />
		<path d="M10.5 8.2h3.5M2 6h12" />
	</svg>
);
export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
	</svg>
);
export const IconRetry = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.8h2.8" />
	</svg>
);
export const IconEdit = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M10.5 3.5 12.5 5.5 6 12H4v-2zM9.5 4.5l2 2" />
	</svg>
);
export const IconBranch = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<circle cx="5" cy="4" r="1.4" />
		<circle cx="5" cy="12" r="1.4" />
		<circle cx="11" cy="6" r="1.4" />
		<path d="M5 5.4v5.2M11 7.4c0 2.2-2 3-6 3.6" />
	</svg>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<circle cx="7" cy="7" r="4" />
		<path d="m10 10 3 3" />
	</svg>
);
export const IconFile = (p: SVGProps<SVGSVGElement>) => (
	<svg {...base(p)}>
		<path d="M4 2.5h5l3 3v8H4z" />
		<path d="M9 2.5v3h3" />
	</svg>
);
