/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// combination of various Things From The Internet (stackoverflow posts etc)
// color stuff like this goes right over my head

export function hexStringToHSL(hex: string): [number, number, number] {
    const r = parseInt("0x" + hex[1] + hex[2]) / 255;
    const g = parseInt("0x" + hex[3] + hex[4]) / 255;
    const b = parseInt("0x" + hex[5] + hex[6]) / 255;

    const cmin = Math.min(r,g,b);
    const cmax = Math.max(r,g,b);
    const delta = cmax - cmin;

    let [h, s, l] = [0, 0, 0];

    if (delta === 0) h = 0;
    else if (cmax === r) h = ((g - b) / delta) % 6;
    else if (cmax === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;

    h = Math.round(h * 60);

    if (h < 0)
        h += 360;

    l = (cmax + cmin) / 2;
    s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    s = +(s * 100).toFixed(1);
    l = +(l * 100).toFixed(1);

    return [h, s, l];
}

export function hslToHexString(hsl: [number, number, number]): string {
    let [h, s, l] = hsl;
    s /= 100;
    l /= 100;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c/2;
    let [r, g, b] = [0, 0, 0];

    if (h >= 0 && h < 60) [r, g, b] = [c, x, 0];
    else if (h >= 60 && h < 120) [r, g, b] = [x, c, 0];
    else if (h >= 120 && h < 180) [r, g, b] = [0, c, x];
    else if (h >= 180 && h < 240) [r, g, b] = [0, x, c];
    else if (h >= 240 && h < 300) [r, g, b] = [x, 0 ,c];
    else if (h >= 300 && h < 360) [r, g, b] = [c, 0, x];

    let rs = Math.round((r + m) * 255).toString(16);
    let gs = Math.round((g + m) * 255).toString(16);
    let bs = Math.round((b + m) * 255).toString(16);

    if (rs.length === 1) rs = "0" + r;
    if (gs.length === 1) gs = "0" + g;
    if (bs.length === 1) bs = "0" + b;

    return "#" + rs + gs + bs;
}
