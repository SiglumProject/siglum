/** Package sources must follow the engine year, including explicit compatibility fallbacks. */
export const TEXLIVE_YEAR = 2026;
export const SUPPORTED_TL_YEARS = [2026, 2025, 2024, 2023];
const CURRENT_ROOT = 'https://tug.ctan.org/systems/texlive/tlnet';
const historicRoot = year => `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/${year}/tlnet-final`;
export function validPackageName(name) { return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(name) && !name.includes('..'); }
/** @param {string} name @param {number} year @param {typeof fetch} fetcher @param {RequestInit} options */
export async function fetchTexLiveArchive(name, year = TEXLIVE_YEAR, fetcher = fetch, options = {}) {
    if (!validPackageName(name) || !SUPPORTED_TL_YEARS.includes(year)) throw new Error('Invalid TeX Live package or year');
    let root = historicRoot(year);
    // tlnet changes year annually. Never silently fetch next year's packages for
    // a 2026 engine; use the historic archive once the marker disappears.
    if (year === TEXLIVE_YEAR) {
        const marker = await fetcher(`${CURRENT_ROOT}/TEXLIVE_${TEXLIVE_YEAR}`);
        if (marker.ok) root = CURRENT_ROOT;
    }
    return fetcher(`${root}/archive/${name}.tar.xz`, { ...options, redirect: 'follow' });
}
