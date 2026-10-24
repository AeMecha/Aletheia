/**
 * Route collection-wide questions to the actual document inventory. Semantic
 * top-k search answers a different question and can legitimately return no hits
 * for words such as "archive" even when the collection contains many records.
 * Keep these patterns anchored: "what does my archive contain about magic?"
 * must still perform a topical search instead of listing unrelated documents.
 */
export function isInventoryQuestion(question) {
    if (typeof question !== 'string') return false;
    const text = question.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').replace(/^[ ?.!,]+|[ ?.!,]+$/g, '')
        .replace(/,? please$/, '').replace(/[ ?.!,]+$/g, '')
        .replace(/^(?:(?:please|(?:can|could|would) you|tell me(?: (?:if|whether))?|(?:check|see|confirm)(?: to see)?(?: (?:if|whether))?),? )+/, '');
    const collection = '(?:(?:my|the|this|our) )?(?:archive|library|collection)';
    const records = '(?:documents|notes|entries|files|records|topics|items)';
    const contents = `(?:anything|something|stuff|(?:any |some )?(?:saved |archived )?${records}|(?:any |some )?content)`;
    const location = `(?: (?:in|inside) ${collection})?`;
    const saved = '(?:saved|archived|recorded|stored|added|imported|uploaded)';
    return [
        `^what (?:does|do) ${collection} (?:contain|include|hold|have)$`,
        `^what ${collection} (?:contains|includes|holds|has)$`,
        `^what(?: is|'s)(?: ${saved})? (?:in|inside) ${collection}$`,
        `^what (?:topics|subjects) (?:are covered by|are in) (?:the )?(?:saved documents|${collection})$`,
        `^what ${records} (?:do (?:i|we) have|have (?:i|we) ${saved})${location}$`,
        `^what do (?:i|we) have(?: ${saved})?${location}$`,
        `^what have (?:i|we) ${saved}(?: (?:in|into|to) ${collection})?(?: so far)?$`,
        `^(?:show|give)(?: me)? (?:an? )?(?:overview|summary|inventory|list|contents)(?: of| for)? ${collection}$`,
        `^(?:list|show)(?: me)?(?: all)? (?:my |the |saved )?${records}(?: in ${collection})?$`,
        `^(?:summari[sz]e|describe) ${collection}$`,
        `^how many ${records} (?:are (?:there )?in ${collection}|do (?:i|we) have|have (?:i|we) (?:saved|archived))$`,
        `^${collection} (?:overview|contents|inventory)$`,
        // Existence checks use the index even when the generation model is off.
        // Anchors preserve topic/date filters as passage searches.
        `^(?:do (?:i|we)|(?:i|we)) have ${contents}(?: ${saved})?${location}(?: yet| so far)?$`,
        `^(?:have (?:i|we)|(?:i|we) have) ${saved} ${contents}(?: (?:in|into|to) ${collection})?(?: yet| so far)?$`,
        `^(?:(?:is|are) there|there (?:is|are)) ${contents}(?: ${saved})?${location}$`,
        `^(?:does ${collection} (?:have|contain|include|hold)|${collection} (?:has|contains|includes|holds)) ${contents}$`,
        `^(?:is ${collection}|${collection} is) (?:empty|not empty|nonempty)$`,
        `^${contents}(?: ${saved})? (?:in|inside) ${collection}$`,
    ].some(pattern => new RegExp(pattern).test(text));
}

/** Format only facts from the index; no model call is needed to count files. */
export function formatInventory(inventory) {
    if (!inventory.total) return { answer: 'Your archive is empty. Import Markdown documents in Your library, or save a document with the Archivist.', sources: [], search_scope: 'archive_inventory' };
    const lines = [`Your archive contains ${inventory.total} document${inventory.total === 1 ? '' : 's'}.`];
    if (inventory.types.length) lines.push('Common document types: ' + inventory.types.map(item => `${item.type} (${item.count})`).join(', ') + '.');
    if (inventory.topics.length) lines.push('Common topics recorded in document metadata: ' + inventory.topics.map(item => item.topic).join(', ') + '.');
    lines.push((inventory.documents.length === inventory.total ? 'Documents:' : `Showing ${inventory.documents.length} examples from the archive:`)
        + '\n' + inventory.documents.map(document => '• ' + document.title).join('\n'));
    if (inventory.documents.length < inventory.total) lines.push('Open Your library to browse the documents. The total above counts the entire indexed archive.');
    return { answer: lines.join('\n\n'), sources: inventory.documents.map(({ id, title }) => ({ id, title, is_excerpt: false })), search_scope: 'archive_inventory' };
}
