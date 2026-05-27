// Branded "OMNIDIMENSION" wordmark shown at the top of `setup`. The ANSI
// Shadow art is baked in (generated once with figlet) so the package ships
// no figlet dependency. OMNI uses the brand cyan, DIMENSION the light slate.
const OMNI_ROWS = [
    " ██████╗ ███╗   ███╗███╗   ██╗██╗",
    "██╔═══██╗████╗ ████║████╗  ██║██║",
    "██║   ██║██╔████╔██║██╔██╗ ██║██║",
    "██║   ██║██║╚██╔╝██║██║╚██╗██║██║",
    "╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║",
    " ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝",
];
const DIM_ROWS = [
    "██████╗ ██╗███╗   ███╗███████╗███╗   ██╗███████╗██╗ ██████╗ ███╗   ██╗",
    "██╔══██╗██║████╗ ████║██╔════╝████╗  ██║██╔════╝██║██╔═══██╗████╗  ██║",
    "██║  ██║██║██╔████╔██║█████╗  ██╔██╗ ██║███████╗██║██║   ██║██╔██╗ ██║",
    "██║  ██║██║██║╚██╔╝██║██╔══╝  ██║╚██╗██║╚════██║██║██║   ██║██║╚██╗██║",
    "██████╔╝██║██║ ╚═╝ ██║███████╗██║ ╚████║███████║██║╚██████╔╝██║ ╚████║",
    "╚═════╝ ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

export const WORDMARK_WIDTH = OMNI_ROWS[0].length + DIM_ROWS[0].length;

const OMNI_RGB: [number, number, number] = [19, 180, 174]; // #13B4AE
const DIM_RGB: [number, number, number] = [192, 210, 216]; // #C0D2D8
const OMNI_256 = 37;
const DIM_256 = 152;

function supportsTrueColor(): boolean {
    const ct = (process.env.COLORTERM || "").toLowerCase();
    return ct.includes("truecolor") || ct.includes("24bit");
}

// One colorizer for a block of rows, picking 24-bit or 256-color up front.
function painter(rgb: [number, number, number], code256: number): (s: string) => string {
    const open = supportsTrueColor()
        ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
        : `\x1b[38;5;${code256}m`;
    return (s) => `${open}${s}\x1b[0m`;
}

// The colored multi-line wordmark, or null when the terminal is too narrow
// to render it without wrapping (the caller falls back to the compact line).
export function renderWordmark(columns: number | undefined): string | null {
    if (!columns || columns < WORDMARK_WIDTH + 2) return null;
    const omni = painter(OMNI_RGB, OMNI_256);
    const dimn = painter(DIM_RGB, DIM_256);
    return OMNI_ROWS.map((row, i) => `  ${omni(row)}${dimn(DIM_ROWS[i])}`).join("\n");
}
