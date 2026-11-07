// SPDX-License-Identifier: AGPL-3.0-or-later
// local/marks.js —— 手动标记（与后端 marks.json 结构、响应体一致）

export const SUPPORTED_MARK_TYPES = ['rphub'];

export function isSupportedMarkType(type) {
    return SUPPORTED_MARK_TYPES.includes(type);
}

export function findMark(marksObj, contentHash) {
    const marks = marksObj && typeof marksObj === 'object' ? (marksObj.marks || marksObj) : {};
    return marks[contentHash] || null;
}

export function buildMark(type, note) {
    return {
        type,
        note: note !== undefined && note !== null ? String(note) : undefined,
        markedAt: new Date().toISOString(),
    };
}

export function setMark(marksObj, contentHash, type, note) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : undefined;
    const store = marks ? marks : {};
    const mark = buildMark(type, note);
    store[contentHash] = mark;
    if (!marks && marksObj) marksObj.marks = store;
    return { contentHash, marked: true, mark };
}

export function clearMark(marksObj, contentHash) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : undefined;
    const store = marks ? marks : {};
    if (contentHash in store) delete store[contentHash];
    if (!marks && marksObj) marksObj.marks = store;
    return { contentHash, marked: false, mark: null };
}

export function listMarks(marksObj) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : {};
    return Object.entries(marks || {}).map(([contentHash, mark]) => ({
        contentHash,
        type: mark.type,
        note: mark.note,
        markedAt: mark.markedAt,
    }));
}

export function getMarkStatus(marksObj, contentHash) {
    const mark = findMark(marksObj, contentHash);
    return { contentHash, marked: !!mark, mark: mark || null };
}
