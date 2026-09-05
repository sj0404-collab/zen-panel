package mihon.domain.dictionary.interactor

/**
 * Controls which language parser [SearchDictionaryTerms] uses when searching.
 *
 * Pass one of these values to [SearchDictionaryTerms.search] or
 * [SearchDictionaryTerms.findFirstWordMatch] via the [parserLanguage] parameter.
 * The default, [AUTO], lets the interactor infer the parser from the query's
 * character script automatically.
 */
enum class ParserLanguage {
    /** Detect the script automatically from the query text (default). */
    AUTO,

    /** Force the Japanese pipeline: romaji -> kana conversion and deinflection. */
    JAPANESE,

    /** Force the Korean pipeline: direct character-by-character longest match. */
    KOREAN,

    /** Force the Chinese pipeline: CJK character-by-character longest match. */
    CHINESE,

    /** Force the English pipeline: space-delimited words. */
    ENGLISH,
}
