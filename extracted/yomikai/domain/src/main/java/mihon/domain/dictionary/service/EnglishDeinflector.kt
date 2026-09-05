package mihon.domain.dictionary.service

/**
 * English deinflector (deconjugator / deinflector) for dictionary searches.
 *
 * Ported from the minimal pieces of the `compromise` NLP project needed to
 * generate likely base-form candidates for inflected English tokens.
 */
object EnglishDeinflector {

    fun deinflect(source: String): List<Candidate> {
        val trimmed = source.trim()
        if (trimmed.isBlank()) return emptyList()

        val results = LinkedHashMap<String, Candidate>(32)
        val queue = ArrayDeque<Candidate>()

        fun enqueueIfNew(candidate: Candidate) {
            val existing = results[candidate.term]
            if (existing == null) {
                results[candidate.term] = candidate
                queue.addLast(candidate)
                return
            }

            val existingDepth = existing.reasons.size
            val newDepth = candidate.reasons.size
            if (newDepth < existingDepth) {
                results[candidate.term] = candidate
                queue.addLast(candidate)
                return
            }

            if (newDepth == existingDepth && existing.reasons != candidate.reasons) {
                val allChains = LinkedHashSet<List<String>>()
                allChains.add(existing.reasons.toList())
                allChains.addAll(existing.alternateReasonChains)
                allChains.add(candidate.reasons.toList())

                val primaryChain = allChains.minWithOrNull(
                    compareBy(
                        { it.size },
                        { it.joinToString("\u0000") },
                    ),
                ) ?: existing.reasons.toList()

                val alternateChains = allChains
                    .asSequence()
                    .filterNot { it == primaryChain }
                    .toSet()

                results[candidate.term] = existing.copy(
                    reasons = ArrayDeque(primaryChain),
                    alternateReasonChains = alternateChains,
                    canBeFinal = existing.canBeFinal || candidate.canBeFinal,
                    conditions = existing.conditions or candidate.conditions,
                    hasAppliedRule = existing.hasAppliedRule || candidate.hasAppliedRule,
                )
            }
        }

        enqueueIfNew(
            Candidate(
                term = trimmed,
                conditions = 0L,
                reasons = ArrayDeque(),
                canBeFinal = true,
                hasAppliedRule = false,
            ),
        )

        val lowered = trimmed.lowercase()
        if (lowered != trimmed) {
            enqueueIfNew(
                Candidate(
                    term = lowered,
                    conditions = 0L,
                    reasons = ArrayDeque(),
                    canBeFinal = true,
                    hasAppliedRule = false,
                ),
            )
        }

        val processed = HashSet<String>(64)

        while (queue.isNotEmpty() && results.size < MAX_CANDIDATES) {
            val current = queue.removeFirst()
            if (!processed.add(current.term)) continue
            if (current.reasons.size >= MAX_DEPTH) continue

            val term = current.term

            applyLastToken(term) { stripPossessive(it) }?.let { stripped ->
                enqueueIfNew(current.derived(stripped, "possessive"))
            }

            val firstTokenLower = term.substringBefore(' ').lowercase()
            if (COPULA_FORMS.contains(firstTokenLower)) {
                applyFirstToken(term) { "be" }?.let { converted ->
                    enqueueIfNew(current.derived(converted, "copula"))
                }
            } else {
                // Verb deconjugation on the first token: "looked up" -> "look up"
                applyFirstToken(term) { token ->
                    val w = token.lowercase()
                    firstNonNullDistinct(
                        w,
                        MODELS.fromGerund.maybeConvert(w),
                        MODELS.fromPast.maybeConvert(w),
                        MODELS.fromParticiple.maybeConvert(w),
                        MODELS.fromPresent.maybeConvert(w),
                    )
                }?.let { converted ->
                    enqueueIfNew(current.derived(converted, reasonForVerb(term, converted)))
                }

                // Additional verb candidates (one per inflection class)
                applyFirstToken(term) { MODELS.fromGerund.maybeConvert(it.lowercase()) }
                    ?.let { enqueueIfNew(current.derived(it, "gerund")) }
                applyFirstToken(term) { MODELS.fromPast.maybeConvert(it.lowercase()) }
                    ?.let { enqueueIfNew(current.derived(it, "past")) }
                applyFirstToken(term) { MODELS.fromParticiple.maybeConvert(it.lowercase()) }
                    ?.let { enqueueIfNew(current.derived(it, "participle")) }
                applyFirstToken(term) { MODELS.fromPresent.maybeConvert(it.lowercase()) }
                    ?.let { enqueueIfNew(current.derived(it, "present")) }
            }

            // Adjectives on the last token: "bigger" -> "big"
            run {
                val (head, tail) = splitLastToken(term)
                val w = tail.lowercase()

                for (base in simpleComparativeBases(w)) {
                    enqueueIfNew(current.derived(head + base, "comparative"))
                }
                MODELS.fromComparative.maybeConvert(w)?.let { base ->
                    enqueueIfNew(current.derived(head + base, "comparative"))
                }

                for (base in simpleSuperlativeBases(w)) {
                    enqueueIfNew(current.derived(head + base, "superlative"))
                }
                MODELS.fromSuperlative.maybeConvert(w)?.let { base ->
                    enqueueIfNew(current.derived(head + base, "superlative"))
                }
            }

            // Nouns on the last token: "children" -> "child"
            applyLastToken(term) { token ->
                val w = token.lowercase()
                toSingular(w).takeIf { it != w }
            }?.let { enqueueIfNew(current.derived(it, "plural")) }
        }

        return results.values.toList()
    }

    private fun Candidate.derived(newTerm: String, reason: String): Candidate {
        if (newTerm.isBlank() || newTerm == term) return this
        val nextReasons = ArrayDeque(reasons).also { it.addLast(reason) }
        return copy(
            term = newTerm,
            reasons = nextReasons,
            canBeFinal = true,
            hasAppliedRule = true,
        )
    }

    private fun applyFirstToken(term: String, transform: (String) -> String?): String? {
        val idx = term.indexOf(' ')
        return if (idx < 0) {
            transform(term)?.takeIf { it != term }
        } else {
            val head = term.substring(0, idx)
            val tail = term.substring(idx)
            val newHead = transform(head)?.takeIf { it != head } ?: return null
            newHead + tail
        }
    }

    private fun applyLastToken(term: String, transform: (String) -> String?): String? {
        val idx = term.lastIndexOf(' ')
        return if (idx < 0) {
            transform(term)?.takeIf { it != term }
        } else {
            val head = term.substring(0, idx + 1)
            val tail = term.substring(idx + 1)
            val newTail = transform(tail)?.takeIf { it != tail } ?: return null
            head + newTail
        }
    }

    private fun splitLastToken(term: String): Pair<String, String> {
        val idx = term.lastIndexOf(' ')
        return if (idx < 0) {
            "" to term
        } else {
            term.substring(0, idx + 1) to term.substring(idx + 1)
        }
    }

    private fun stripPossessive(token: String): String? {
        if (token.length < 3) return null
        return when {
            token.endsWith("'s") || token.endsWith("’s") -> token.dropLast(2)
            token.endsWith("s'") || token.endsWith("s’") -> token.dropLast(1)
            else -> null
        }
    }

    private fun firstNonNullDistinct(original: String, vararg candidates: String?): String? {
        for (c in candidates) {
            if (!c.isNullOrBlank() && c != original) return c
        }
        return null
    }

    private fun reasonForVerb(from: String, to: String): String {
        val fromToken = from.substringBefore(' ').lowercase()
        val toToken = to.substringBefore(' ').lowercase()
        if (fromToken == toToken) return "verb"
        if (toToken == "be" && COPULA_FORMS.contains(fromToken)) return "copula"
        return when (toToken) {
            MODELS.fromGerund.maybeConvert(fromToken) -> "gerund"
            MODELS.fromPast.maybeConvert(fromToken) -> "past"
            MODELS.fromParticiple.maybeConvert(fromToken) -> "participle"
            MODELS.fromPresent.maybeConvert(fromToken) -> "present"
            else -> "verb"
        }
    }

    private const val MAX_CANDIDATES = 64
    private const val MAX_DEPTH = 4

    private val COPULA_FORMS: Set<String> = setOf(
        "am",
        "are",
        "is",
        "was",
        "were",
        "be",
        "been",
        "being",
    )

    private fun simpleComparativeBases(word: String): List<String> {
        // return plausible base candidates for a comparative adjective
        if (word.length < 4) return emptyList()
        return when (word) {
            "better" -> listOf("good")
            "worse" -> listOf("bad")
            "farther", "further" -> listOf("far")
            else -> {
                val out = ArrayList<String>(3)
                if (word.endsWith("ier") && word.length > 4) {
                    out.add(word.dropLast(3) + "y")
                } else if (word.endsWith("er") && word.length > 3) {
                    val stem = word.dropLast(2)
                    out.add(undoubleFinalConsonant(stem))
                    out.add(stem)
                    out.add(stem + "e")
                }
                out.distinct()
            }
        }
    }

    private fun simpleSuperlativeBases(word: String): List<String> {
        // return plausible base candidates for a superlative adjective
        if (word.length < 5) return emptyList()
        return when (word) {
            "best" -> listOf("good")
            "worst" -> listOf("bad")
            "furthest", "farthest" -> listOf("far")
            else -> {
                val out = ArrayList<String>(3)
                if (word.endsWith("iest") && word.length > 5) {
                    out.add(word.dropLast(4) + "y")
                } else if (word.endsWith("est") && word.length > 4) {
                    val stem = word.dropLast(3)
                    out.add(undoubleFinalConsonant(stem))
                    out.add(stem)
                    out.add(stem + "e")
                }
                out.distinct()
            }
        }
    }

    private fun undoubleFinalConsonant(stem: String): String {
        if (stem.length < 2) return stem
        val a = stem[stem.length - 1]
        val b = stem[stem.length - 2]
        if (a != b) return stem
        return stem.dropLast(1)
    }

    private fun toSingular(word: String): String {
        IRREGULAR_PLURAL_TO_SINGULAR[word]?.let { return it }
        for (rule in SINGULAR_RULES) {
            if (rule.regex.containsMatchIn(word)) {
                return word.replace(rule.regex, rule.replacement)
            }
        }
        return word
    }

    private data class RegexRule(val regex: Regex, val replacement: String)

    private val SINGULAR_RULES: List<RegexRule> = listOf(
        RegexRule(Regex("([^v])ies$", setOf(RegexOption.IGNORE_CASE)), "$1y"),
        RegexRule(Regex("(ise)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(kn|[^o]l|w)ives$", setOf(RegexOption.IGNORE_CASE)), "$1ife"),
        RegexRule(
            Regex("^((?:ca|e|ha|(?:our|them|your)?se|she|wo)l|lea|loa|shea|thie)ves$", setOf(RegexOption.IGNORE_CASE)),
            "$1f",
        ),
        RegexRule(Regex("^(dwar|handkerchie|hoo|scar|whar)ves$", setOf(RegexOption.IGNORE_CASE)), "$1f"),
        RegexRule(Regex("(antenn|formul|nebul|vertebr|vit)ae$", setOf(RegexOption.IGNORE_CASE)), "$1a"),
        RegexRule(Regex("(octop|vir|radi|nucle|fung|cact|stimul)(i)$", setOf(RegexOption.IGNORE_CASE)), "$1us"),
        RegexRule(Regex("(buffal|tomat|tornad)(oes)$", setOf(RegexOption.IGNORE_CASE)), "$1o"),
        RegexRule(Regex("(ause)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ease)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ious)es$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ouse)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ose)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(..ase)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(..[aeiu]s)es$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(vert|ind|cort)(ices)$", setOf(RegexOption.IGNORE_CASE)), "$1ex"),
        RegexRule(Regex("(matr|append)(ices)$", setOf(RegexOption.IGNORE_CASE)), "$1ix"),
        RegexRule(Regex("([xo]|ch|ss|sh)es$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("men$", setOf(RegexOption.IGNORE_CASE)), "man"),
        RegexRule(Regex("(n)ews$", setOf(RegexOption.IGNORE_CASE)), "$1ews"),
        RegexRule(Regex("([ti])a$", setOf(RegexOption.IGNORE_CASE)), "$1um"),
        RegexRule(Regex("([^aeiouy]|qu)ies$", setOf(RegexOption.IGNORE_CASE)), "$1y"),
        RegexRule(Regex("(s)eries$", setOf(RegexOption.IGNORE_CASE)), "$1eries"),
        RegexRule(Regex("(m)ovies$", setOf(RegexOption.IGNORE_CASE)), "$1ovie"),
        RegexRule(Regex("(cris|ax|test)es$", setOf(RegexOption.IGNORE_CASE)), "$1is"),
        RegexRule(Regex("(alias|status)es$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ss)$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("(ic)s$", setOf(RegexOption.IGNORE_CASE)), "$1"),
        RegexRule(Regex("s$", setOf(RegexOption.IGNORE_CASE)), ""),
    )

    private val IRREGULAR_PLURAL_TO_SINGULAR: Map<String, String> = buildMap {
        val singularToPlural = mapOf(
            "addendum" to "addenda",
            "corpus" to "corpora",
            "criterion" to "criteria",
            "curriculum" to "curricula",
            "genus" to "genera",
            "memorandum" to "memoranda",
            "opus" to "opera",
            "ovum" to "ova",
            "phenomenon" to "phenomena",
            "referendum" to "referenda",
            "alga" to "algae",
            "alumna" to "alumnae",
            "antenna" to "antennae",
            "formula" to "formulae",
            "larva" to "larvae",
            "nebula" to "nebulae",
            "vertebra" to "vertebrae",
            "analysis" to "analyses",
            "axis" to "axes",
            "diagnosis" to "diagnoses",
            "parenthesis" to "parentheses",
            "prognosis" to "prognoses",
            "synopsis" to "synopses",
            "thesis" to "theses",
            "neurosis" to "neuroses",
            "appendix" to "appendices",
            "index" to "indices",
            "matrix" to "matrices",
            "ox" to "oxen",
            "sex" to "sexes",
            "alumnus" to "alumni",
            "bacillus" to "bacilli",
            "cactus" to "cacti",
            "fungus" to "fungi",
            "hippopotamus" to "hippopotami",
            "libretto" to "libretti",
            "modulus" to "moduli",
            "nucleus" to "nuclei",
            "octopus" to "octopi",
            "radius" to "radii",
            "stimulus" to "stimuli",
            "syllabus" to "syllabi",
            "cookie" to "cookies",
            "calorie" to "calories",
            "auntie" to "aunties",
            "movie" to "movies",
            "pie" to "pies",
            "rookie" to "rookies",
            "tie" to "ties",
            "zombie" to "zombies",
            "leaf" to "leaves",
            "loaf" to "loaves",
            "thief" to "thieves",
            "foot" to "feet",
            "goose" to "geese",
            "tooth" to "teeth",
            "beau" to "beaux",
            "chateau" to "chateaux",
            "tableau" to "tableaux",
            "bus" to "buses",
            "gas" to "gases",
            "circus" to "circuses",
            "crisis" to "crises",
            "virus" to "viruses",
            "database" to "databases",
            "excuse" to "excuses",
            "abuse" to "abuses",
            "avocado" to "avocados",
            "barracks" to "barracks",
            "child" to "children",
            "clothes" to "clothes",
            "echo" to "echoes",
            "embargo" to "embargoes",
            "epoch" to "epochs",
            "deer" to "deer",
            "halo" to "halos",
            "man" to "men",
            "woman" to "women",
            "mosquito" to "mosquitoes",
            "mouse" to "mice",
            "person" to "people",
            "quiz" to "quizzes",
            "rodeo" to "rodeos",
            "shoe" to "shoes",
            "sombrero" to "sombreros",
            "stomach" to "stomachs",
            "tornado" to "tornados",
            "tuxedo" to "tuxedos",
            "volcano" to "volcanoes",
        )

        for ((singular, plural) in singularToPlural) {
            put(plural, singular)
        }
    }

    private data class Rule(val fromSuffix: String, val toSuffix: String, val priority: Int)

    private class ForwardModel(
        private val exceptions: Map<String, String>,
        rules: List<Rule>,
    ) {
        private val rulesByLastChar: Map<Char, List<Rule>>
        private val emptySuffixRules: List<Rule>

        init {
            val byLast = HashMap<Char, MutableList<Rule>>()
            val empty = ArrayList<Rule>()
            for (rule in rules) {
                val from = rule.fromSuffix
                if (from.isEmpty()) {
                    empty.add(rule)
                } else {
                    byLast.getOrPut(from.last()) { ArrayList() }.add(rule)
                }
            }
            for ((k, v) in byLast) {
                v.sortWith(compareByDescending<Rule> { it.fromSuffix.length }.thenBy { it.priority })
                byLast[k] = v
            }
            empty.sortWith(compareByDescending<Rule> { it.fromSuffix.length }.thenBy { it.priority })
            rulesByLastChar = byLast
            emptySuffixRules = empty
        }

        fun maybeConvert(word: String): String? {
            val out = convert(word)
            return out.takeIf { it != word }
        }

        fun convert(word: String): String {
            exceptions[word]?.let { return it }
            if (word.isEmpty()) return word

            rulesByLastChar[word.last()]?.let { rules ->
                for (rule in rules) {
                    if (word.endsWith(rule.fromSuffix)) {
                        val stem = word.dropLast(rule.fromSuffix.length)
                        val out = stem + rule.toSuffix
                        if (out.isNotBlank()) return out
                    }
                }
            }

            for (rule in emptySuffixRules) {
                val out = word + rule.toSuffix
                if (out.isNotBlank() && out != word) return out
            }

            return word
        }
    }

    private class SuffixModel(
        private val fwd: List<Rule>,
        private val both: List<Rule>,
        private val rev: List<Rule>,
        private val exceptionsFwd: Map<String, String>,
    ) {
        fun forward(): ForwardModel = ForwardModel(
            exceptions = exceptionsFwd,
            rules = fwd + both,
        )

        fun reversedForward(): ForwardModel = ForwardModel(
            exceptions = invertMap(exceptionsFwd),
            // `rev` is authored specifically for reverse conversion; keep it first.
            rules = rev + invertRules(fwd, priorityBump = 1) + invertRules(both, priorityBump = 1),
        )

        private fun invertRules(rules: List<Rule>, priorityBump: Int): List<Rule> =
            rules.map { r ->
                Rule(
                    fromSuffix = r.toSuffix,
                    toSuffix = r.fromSuffix,
                    priority = r.priority + priorityBump,
                )
            }

        private fun invertMap(m: Map<String, String>): Map<String, String> = buildMap(m.size) {
            for ((k, v) in m) {
                if (!containsKey(v)) put(v, k)
            }
        }
    }

    private object MODELS {
        private val past = parseSuffixModel(Data.PastTense)
        private val present = parseSuffixModel(Data.PresentTense)
        private val gerund = parseSuffixModel(Data.Gerund)
        private val participle = parseSuffixModel(Data.Participle)

        private val comparativeTo = parseSuffixModel(Data.Comparative)
        private val superlativeTo = parseSuffixModel(Data.Superlative)

        val fromPast: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { past.forward() }
        val fromPresent: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { present.forward() }
        val fromGerund: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { gerund.forward() }
        val fromParticiple: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { participle.forward() }

        val fromComparative: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { comparativeTo.reversedForward() }
        val fromSuperlative: ForwardModel by lazy(LazyThreadSafetyMode.PUBLICATION) { superlativeTo.reversedForward() }
    }

    private fun parseSuffixModel(src: Data.Model): SuffixModel {
        val fwdRules = parseRules(src.fwd, priority = 0)
        val bothRules = parseRules(src.both, priority = 1)
        val revRules = parseRules(src.rev, priority = 0)
        val exceptions = parseExceptions(src.ex)
        return SuffixModel(
            fwd = fwdRules,
            both = bothRules,
            rev = revRules,
            exceptionsFwd = exceptions,
        )
    }

    private fun parseRules(raw: String, priority: Int): List<Rule> {
        if (raw.isBlank()) return emptyList()
        val out = ArrayList<Rule>(64)
        val groups = raw.split(BROKEN_BAR)
        for (g0 in groups) {
            val g = g0.trim()
            if (g.isEmpty()) continue
            val colon = g.indexOf(':')
            if (colon < 0) continue
            val outputSpec = g.substring(0, colon).trim()
            val inputs = g.substring(colon + 1).trim()
            if (inputs.isEmpty()) continue

            val variants = inputs.split(',')
            for (fromSuffix0 in variants) {
                val fromSuffix = fromSuffix0.trim()
                if (fromSuffix.isEmpty()) continue
                val toSuffix = expand(outputSpec, fromSuffix)
                out.add(Rule(fromSuffix = fromSuffix, toSuffix = toSuffix, priority = priority))
            }
        }
        return out
    }

    private fun parseExceptions(raw: String): Map<String, String> {
        if (raw.isBlank()) return emptyMap()
        val out = HashMap<String, String>(128)
        val groups = raw.split(BROKEN_BAR)
        for (g0 in groups) {
            val g = g0.trim()
            if (g.isEmpty()) continue
            val colon = g.indexOf(':')
            if (colon < 0) continue
            val outputSpec = g.substring(0, colon).trim()
            val inputs = g.substring(colon + 1).trim()
            if (inputs.isEmpty()) continue

            val variants = inputs.split(',')
            for (input0 in variants) {
                val inputWord = input0.trim()
                if (inputWord.isEmpty()) continue
                out.putIfAbsent(inputWord, expand(outputSpec, inputWord))
            }
        }
        return out
    }

    private fun expand(outputSpec: String, input: String): String {
        if (outputSpec.isEmpty()) return ""
        var i = 0
        while (i < outputSpec.length && outputSpec[i].isDigit()) i++
        if (i == 0) return outputSpec
        val keep = outputSpec.substring(0, i).toIntOrNull() ?: 0
        val append = outputSpec.substring(i)
        val prefix = if (keep <= 0) "" else input.take(keep.coerceAtMost(input.length))
        return prefix + append
    }

    private const val BROKEN_BAR = '\u00A6'

    private object Data {
        data class Model(
            val fwd: String,
            val both: String,
            val rev: String,
            val ex: String,
        )

        val PastTense = Model(
            fwd = """
                1:tted,wed,gged,nned,een,rred,pped,yed,bbed,oed,dded,rd,wn,mmed
                ¦2:eed,nded,et,hted,st,oled,ut,emed,eled,lded,ken,rt,nked,apt,ant,eped,eked
                ¦3:eared,eat,eaded,nelled,ealt,eeded,ooted,eaked,eaned,eeted,mited,bid,uit,ead,uited,ealed,geted,velled,ialed,belled
                ¦4:ebuted,hined,comed
                ¦y:ied
                ¦ome:ame
                ¦ear:ore
                ¦ind:ound
                ¦ing:ung,ang
                ¦ep:pt
                ¦ink:ank,unk
                ¦ig:ug
                ¦all:ell
                ¦ee:aw
                ¦ive:ave
                ¦eeze:oze
                ¦old:eld
                ¦ave:ft
                ¦ake:ook
                ¦ell:old
                ¦ite:ote
                ¦ide:ode
                ¦ine:one
                ¦in:un,on
                ¦eal:ole
                ¦im:am
                ¦ie:ay
                ¦and:ood
                ¦1ise:rose
                ¦1eak:roke
                ¦1ing:rought
                ¦1ive:rove
                ¦1el:elt
                ¦1id:bade
                ¦1et:got
                ¦1y:aid
                ¦1it:sat
                ¦3e:lid
                ¦3d:pent
            """.trimIndent(),
            both = """
                1:aed,fed,xed,hed
                ¦2:sged,xted,wled,rped,lked,kied,lmed,lped,uped,bted,rbed,rked,wned,rled,mped,fted,mned,mbed,zzed,omed,ened,cked,gned,lted,sked,ued,zed,nted,ered,rted,rmed,ced,sted,rned,ssed,rded,pted,ved,cted
                ¦3:cled,eined,siped,ooned,uked,ymed,jored,ouded,ioted,oaned,lged,asped,iged,mured,oided,eiled,yped,taled,moned,yled,lit,kled,oaked,gled,naled,fled,uined,oared,valled,koned,soned,aided,obed,ibed,meted,nicked,rored,micked,keted,vred,ooped,oaded,rited,aired,auled,filled,ouled,ooded,ceted,tolled,oited,bited,aped,tled,vored,dled,eamed,nsed,rsed,sited,owded,pled,sored,rged,osed,pelled,oured,psed,oated,loned,aimed,illed,eured,tred,ioned,celled,bled,wsed,ooked,oiled,itzed,iked,iased,onged,ased,ailed,uned,umed,ained,auded,nulled,ysed,eged,ised,aged,oined,ated,used,dged,doned
                ¦4:ntied,efited,uaked,caded,fired,roped,halled,roked,himed,culed,tared,lared,tuted,uared,routed,pited,naked,miled,houted,helled,hared,cored,caled,tired,peated,futed,ciled,called,tined,moted,filed,sided,poned,iloted,honed,lleted,huted,ruled,cured,named,preted,vaded,sured,talled,haled,peded,gined,nited,uided,ramed,feited,laked,gured,ctored,unged,pired,cuted,voked,eloped,ralled,rined,coded,icited,vided,uaded,voted,mined,sired,noted,lined,nselled,luted,jured,fided,puted,piled,pared,olored,cided,hoked,enged,tured,geoned,cotted,lamed,uiled,waited,udited,anged,luded,mired,uired,raded
                ¦5:modelled,izzled,eleted,umpeted,ailored,rseded,treated,eduled,ecited,rammed,eceded,atrolled,nitored,basted,twined,itialled,ncited,gnored,ploded,xcited,nrolled,namelled,plored,efeated,redited,ntrolled,nfined,pleted,llided,lcined,eathed,ibuted,lloted,dhered,cceded
                ¦3ad:sled
                ¦2aw:drew
                ¦2ot:hot
                ¦2ke:made
                ¦2ow:hrew,grew
                ¦2ose:hose
                ¦2d:ilt
                ¦2in:egan
                ¦1un:ran
                ¦1ink:hought
                ¦1ick:tuck
                ¦1ike:ruck
                ¦1eak:poke,nuck
                ¦1it:pat
                ¦1o:did
                ¦1ow:new
                ¦1ake:woke
                ¦go:went
            """.trimIndent(),
            rev = """
                3:rst,hed,hut,cut,set
                ¦4:tbid
                ¦5:dcast,eread,pread,erbid
                ¦ought:uy,eek
                ¦1ied:ny,ly,dy,ry,fy,py,vy,by,ty,cy
                ¦1ung:ling,ting,wing
                ¦1pt:eep
                ¦1ank:rink
                ¦1ore:bear,wear
                ¦1ave:give
                ¦1oze:reeze
                ¦1ound:rind,wind
                ¦1ook:take,hake
                ¦1aw:see
                ¦1old:sell
                ¦1ote:rite
                ¦1ole:teal
                ¦1unk:tink
                ¦1am:wim
                ¦1ay:lie
                ¦1ood:tand
                ¦1eld:hold
                ¦2d:he,ge,re,le,leed,ne,reed,be,ye,lee,pe,we
                ¦2ed:dd,oy,or,ey,gg,rr,us,ew,to
                ¦2ame:ecome,rcome
                ¦2ped:ap
                ¦2ged:ag,og,ug,eg
                ¦2bed:ub,ab,ib,ob
                ¦2lt:neel
                ¦2id:pay
                ¦2ang:pring
                ¦2ove:trive
                ¦2med:um
                ¦2ode:rride
                ¦2at:ysit
                ¦3ted:mit,hat,mat,lat,pot,rot,bat
                ¦3ed:low,end,tow,und,ond,eem,lay,cho,dow,xit,eld,ald,uld,law,lel,eat,oll,ray,ank,fin,oam,out,how,iek,tay,haw,ait,vet,say,cay,bow
                ¦3d:ste,ede,ode,ete,ree,ude,ame,oke,ote,ime,ute,ade
                ¦3red:lur,cur,pur,car
                ¦3ped:hop,rop,uip,rip,lip,tep,top
                ¦3ded:bed,rod,kid
                ¦3ade:orbid
                ¦3led:uel
                ¦3ned:lan,can,kin,pan,tun
                ¦3med:rim,lim
                ¦4ted:quit,llot
                ¦4ed:pear,rrow,rand,lean,mand,anel,pand,reet,link,abel,evel,imit,ceed,ruit,mind,peal,veal,hool,head,pell,well,mell,uell,band,hear,weak
                ¦4led:nnel,qual,ebel,ivel
                ¦4red:nfer,efer,sfer
                ¦4n:sake,trew
                ¦4d:ntee
                ¦4ded:hred
                ¦4ned:rpin
                ¦5ed:light,nceal,right,ndear,arget,hread,eight,rtial,eboot
                ¦5d:edite,nvite
                ¦5ted:egret
                ¦5led:ravel
            """.trimIndent(),
            ex = """
                2:been,upped
                ¦3:added,aged,aided,aimed,aired,bid,died,dyed,egged,erred,eyed,fit,gassed,hit,lied,owed,pent,pied,tied,used,vied,oiled,outed,banned,barred,bet,canned,cut,dipped,donned,ended,feed,inked,jarred,let,manned,mowed,netted,padded,panned,pitted,popped,potted,put,set,sewn,sowed,tanned,tipped,topped,vowed,weed,bowed,jammed,binned,dimmed,hopped,mopped,nodded,pinned,rigged,sinned,towed,vetted
                ¦4:ached,baked,baled,boned,bored,called,caned,cared,ceded,cited,coded,cored,cubed,cured,dared,dined,edited,exited,faked,fared,filed,fined,fired,fuelled,gamed,gelled,hired,hoped,joked,lined,mined,named,noted,piled,poked,polled,pored,pulled,reaped,roamed,rolled,ruled,seated,shed,sided,timed,tolled,toned,voted,waited,walled,waned,winged,wiped,wired,zoned,yelled,tamed,lubed,roped,faded,mired,caked,honed,banged,culled,heated,raked,welled,banded,beat,cast,cooled,cost,dealt,feared,folded,footed,handed,headed,heard,hurt,knitted,landed,leaked,leapt,linked,meant,minded,molded,neared,needed,peaked,plodded,plotted,pooled,quit,read,rooted,sealed,seeded,seeped,shipped,shunned,skimmed,slammed,sparred,stemmed,stirred,suited,thinned,twinned,swayed,winked,dialed,abutted,blotted,fretted,healed,heeded,peeled,reeled
                ¦5:basted,cheated,equalled,eroded,exiled,focused,opined,pleated,primed,quoted,scouted,shored,sloped,smoked,sniped,spelled,spouted,routed,staked,stored,swelled,tasted,treated,wasted,smelled,dwelled,honored,prided,quelled,eloped,scared,coveted,sweated,breaded,cleared,debuted,deterred,freaked,modeled,pleaded,rebutted,speeded
                ¦6:anchored,defined,endured,impaled,invited,refined,revered,strolled,cringed,recast,thrust,unfolded
                ¦7:authored,combined,competed,conceded,convened,excreted,extruded,redefined,restored,secreted,rescinded,welcomed
                ¦8:expedited,infringed
                ¦9:interfered,intervened,persevered
                ¦10:contravened
                ¦eat:ate
                ¦is:was
                ¦go:went
                ¦are:were
                ¦3d:bent,lent,rent,sent
                ¦3e:bit,fled,hid,lost
                ¦3ed:bled,bred
                ¦2ow:blew,grew
                ¦1uy:bought
                ¦2tch:caught
                ¦1o:did
                ¦1ive:dove,gave
                ¦2aw:drew
                ¦2ed:fed
                ¦2y:flew,laid,paid,said
                ¦1ight:fought
                ¦1et:got
                ¦2ve:had
                ¦1ang:hung
                ¦2ad:led
                ¦2ght:lit
                ¦2ke:made
                ¦2et:met
                ¦1un:ran
                ¦1ise:rose
                ¦1it:sat
                ¦1eek:sought
                ¦1each:taught
                ¦1ake:woke,took
                ¦1eave:wove
                ¦2ise:arose
                ¦1ear:bore,tore,wore
                ¦1ind:bound,found,wound
                ¦2eak:broke
                ¦2ing:brought,wrung
                ¦1ome:came
                ¦2ive:drove
                ¦1ig:dug
                ¦1all:fell
                ¦2el:felt
                ¦4et:forgot
                ¦1old:held
                ¦2ave:left
                ¦1ing:rang,sang
                ¦1ide:rode
                ¦1ink:sank
                ¦1ee:saw
                ¦2ine:shone
                ¦4e:slid
                ¦1ell:sold,told
                ¦4d:spent
                ¦2in:spun
                ¦1in:won
            """.trimIndent(),
        )

        val PresentTense = Model(
            fwd = """
                1:oes
                ¦1ve:as
            """.trimIndent(),
            both = """
                1:xes
                ¦2:zzes,ches,shes,sses
                ¦3:iases
                ¦2y:llies,plies
                ¦1y:cies,bies,ties,vies,nies,pies,dies,ries,fies
                ¦:s
            """.trimIndent(),
            rev = """
                1ies:ly
                ¦2es:us,go,do
                ¦3es:cho,eto
            """.trimIndent(),
            ex = """
                2:does,goes
                ¦3:gasses
                ¦5:focuses
                ¦is:are
                ¦3y:relies
                ¦2y:flies
                ¦2ve:has
            """.trimIndent(),
        )

        val Gerund = Model(
            fwd = """
                1:nning,tting,rring,pping,eing,mming,gging,dding,bbing,kking
                ¦2:eking,oling,eling,eming
                ¦3:velling,siting,uiting,fiting,loting,geting,ialing,celling
                ¦4:graming
            """.trimIndent(),
            both = """
                1:aing,iing,fing,xing,ying,oing,hing,wing
                ¦2:tzing,rping,izzing,bting,mning,sping,wling,rling,wding,rbing,uping,lming,wning,mping,oning,lting,mbing,lking,fting,hting,sking,gning,pting,cking,ening,nking,iling,eping,ering,rting,rming,cting,lping,ssing,nting,nding,lding,sting,rning,rding,rking
                ¦3:belling,siping,toming,yaking,uaking,oaning,auling,ooping,aiding,naping,euring,tolling,uzzing,ganing,haning,ualing,halling,iasing,auding,ieting,ceting,ouling,voring,ralling,garing,joring,oaming,oaking,roring,nelling,ooring,uelling,eaming,ooding,eaping,eeting,ooting,ooming,xiting,keting,ooking,ulling,airing,oaring,biting,outing,oiting,earing,naling,oading,eeding,ouring,eaking,aiming,illing,oining,eaning,onging,ealing,aining,eading
                ¦4:thoming,melling,aboring,ivoting,weating,dfilling,onoring,eriting,imiting,tialling,rgining,otoring,linging,winging,lleting,louding,spelling,mpelling,heating,feating,opelling,choring,welling,ymaking,ctoring,calling,peating,iloring,laiting,utoring,uditing,mmaking,loating,iciting,waiting,mbating,voiding,otalling,nsoring,nselling,ocusing,itoring,eloping
                ¦5:rselling,umpeting,atrolling,treating,tselling,rpreting,pringing,ummeting,ossoming,elmaking,eselling,rediting,totyping,onmaking,rfeiting,ntrolling
                ¦5e:chmaking,dkeeping,severing,erouting,ecreting,ephoning,uthoring,ravening,reathing,pediting,erfering,eotyping,fringing,entoring,ombining,ompeting
                ¦4e:emaking,eething,twining,rruling,chuting,xciting,rseding,scoping,edoring,pinging,lunging,agining,craping,pleting,eleting,nciting,nfining,ncoding,tponing,ecoding,writing,esaling,nvening,gnoring,evoting,mpeding,rvening,dhering,mpiling,storing,nviting,ploring
                ¦3e:tining,nuring,saking,miring,haling,ceding,xuding,rining,nuting,laring,caring,miling,riding,hoking,piring,lading,curing,uading,noting,taping,futing,paring,hading,loding,siring,guring,vading,voking,during,niting,laning,caping,luting,muting,ruding,ciding,juring,laming,caling,hining,uoting,liding,ciling,duling,tuting,puting,cuting,coring,uiding,tiring,turing,siding,rading,enging,haping,buting,lining,taking,anging,haring,uiring,coming,mining,moting,suring,viding,luding
                ¦2e:tring,zling,uging,oging,gling,iging,vring,fling,lging,obing,psing,pling,ubing,cling,dling,wsing,iking,rsing,dging,kling,ysing,tling,rging,eging,nsing,uning,osing,uming,using,ibing,bling,aging,ising,asing,ating
                ¦2ie:rlying
                ¦1e:zing,uing,cing,ving
            """.trimIndent(),
            rev = """
                ying:ie
                ¦1ing:se,ke,te,we,ne,re,de,pe,me,le,c,he
                ¦2ing:ll,ng,dd,ee,ye,oe,rg,us
                ¦2ning:un
                ¦2ging:og,ag,ug,ig,eg
                ¦2ming:um
                ¦2bing:ub,ab,eb,ob
                ¦3ning:lan,can,hin,pin,win
                ¦3ring:cur,lur,tir,tar,pur,car
                ¦3ing:ait,del,eel,fin,eat,oat,eem,lel,ool,ein,uin
                ¦3ping:rop,rap,top,uip,wap,hip,hop,lap,rip,cap
                ¦3ming:tem,wim,rim,kim,lim
                ¦3ting:mat,cut,pot,lit,lot,hat,set,pit,put
                ¦3ding:hed,bed,bid
                ¦3king:rek
                ¦3ling:cil,pel
                ¦3bing:rib
                ¦4ning:egin
                ¦4ing:isit,ruit,ilot,nsit,dget,rkel,ival,rcel
                ¦4ring:efer,nfer
                ¦4ting:rmit,mmit,ysit,dmit,emit,bmit,tfit,gret
                ¦4ling:evel,xcel,ivel
                ¦4ding:hred
                ¦5ing:arget,posit,rofit
                ¦5ring:nsfer
                ¦5ting:nsmit,orget,cquit
                ¦5ling:ancel,istil
            """.trimIndent(),
            ex = """
                3:adding,eating,aiming,aiding,airing,outing,gassing,setting,getting,putting,cutting,winning,sitting,betting,mapping,tapping,letting,bidding,hitting,tanning,netting,popping,fitting,capping,lapping,barring,banning,vetting,topping,rotting,tipping,potting,wetting,pitting,dipping,budding,hemming,pinning,jetting,kidding,padding,podding,sipping,wedding,bedding,donning,warring,penning,gutting,cueing,wadding,petting,ripping,napping,matting,tinning,binning,dimming,hopping,mopping,nodding,panning,rapping,ridding,sinning
                ¦4:selling,falling,calling,waiting,editing,telling,rolling,heating,boating,hanging,beating,coating,singing,tolling,felling,polling,discing,seating,voiding,gelling,yelling,baiting,reining,ruining,seeking,spanning,stepping,knitting,emitting,slipping,quitting,dialing,omitting,clipping,shutting,skinning,abutting,flipping,trotting,cramming,fretting,suiting
                ¦5:bringing,treating,spelling,stalling,trolling,expelling,rivaling,wringing,deterring,singeing,befitting,refitting
                ¦6:enrolling,distilling,scrolling,strolling,caucusing,travelling
                ¦7:installing,redefining,stencilling,recharging,overeating,benefiting,unraveling,programing
                ¦9:reprogramming
                ¦is:being
                ¦2e:using,aging,owing
                ¦3e:making,taking,coming,noting,hiring,filing,coding,citing,doping,baking,coping,hoping,lading,caring,naming,voting,riding,mining,curing,lining,ruling,typing,boring,dining,firing,hiding,piling,taping,waning,baling,boning,faring,honing,wiping,luring,timing,wading,piping,fading,biting,zoning,daring,waking,gaming,raking,ceding,tiring,coking,wining,joking,paring,gaping,poking,pining,coring,liming,toting,roping,wiring,aching
                ¦4e:writing,storing,eroding,framing,smoking,tasting,wasting,phoning,shaking,abiding,braking,flaking,pasting,priming,shoring,sloping,withing,hinging
                ¦5e:defining,refining,renaming,swathing,fringing,reciting
                ¦1ie:dying,tying,lying,vying
                ¦7e:sunbathing
            """.trimIndent(),
        )

        val Participle = Model(
            fwd = """
                1:mt
                ¦2:llen
                ¦3:iven,aken
                ¦:ne
                ¦y:in
            """.trimIndent(),
            both = """
                1:wn
                ¦2:me,aten
                ¦3:seen,bidden,isen
                ¦4:roven,asten
                ¦3l:pilt
                ¦3d:uilt
                ¦2e:itten
                ¦1im:wum
                ¦1eak:poken
                ¦1ine:hone
                ¦1ose:osen
                ¦1in:gun
                ¦1ake:woken
                ¦ear:orn
                ¦eal:olen
                ¦eeze:ozen
                ¦et:otten
                ¦ink:unk
                ¦ing:ung
            """.trimIndent(),
            rev = """
                2:un
                ¦oken:eak
                ¦ought:eek
                ¦oven:eave
                ¦1ne:o
                ¦1own:ly
                ¦1den:de
                ¦1in:ay
                ¦2t:am
                ¦2n:ee
                ¦3en:all
                ¦4n:rive,sake,take
                ¦5n:rgive
            """.trimIndent(),
            ex = """
                2:been
                ¦3:seen,run
                ¦4:given,taken
                ¦5:shaken
                ¦2eak:broken
                ¦1ive:dove
                ¦2y:flown
                ¦3e:hidden,ridden
                ¦1eek:sought
                ¦1ake:woken
                ¦1eave:woven
            """.trimIndent(),
        )

        val Comparative = Model(
            fwd = """
                3:ser,ier
                ¦1er:h,t,f,l,n
                ¦1r:e
                ¦2er:ss,or,om
            """.trimIndent(),
            both = """
                3er:ver,ear,alm
                ¦3ner:hin
                ¦3ter:lat
                ¦2mer:im
                ¦2er:ng,rm,mb
                ¦2ber:ib
                ¦2ger:ig
                ¦1er:w,p,k,d
                ¦ier:y
            """.trimIndent(),
            rev = """
                1:tter,yer
                ¦2:uer,ver,ffer,oner,eler,ller,iler,ster,cer,uler,sher,ener,gher,aner,adder,nter,eter,rter,hter,rner,fter
                ¦3:oser,ooler,eafer,user,airer,bler,maler,tler,eater,uger,rger,ainer,urer,ealer,icher,pler,emner,icter,nser,iser
                ¦4:arser,viner,ucher,rosser,somer,ndomer,moter,oother,uarer,hiter
                ¦5:nuiner,esser,emier
                ¦ar:urther
            """.trimIndent(),
            ex = """
                worse:bad
                ¦better:good
                ¦4er:fair,gray,poor
                ¦1urther:far
                ¦3ter:fat,hot,wet
                ¦3der:mad,sad
                ¦3er:shy,fun
                ¦4der:glad
                ¦:
                ¦4r:cute,dire,fake,fine,free,lame,late,pale,rare,ripe,rude,safe,sore,tame,wide
                ¦5r:eerie,stale
            """.trimIndent(),
        )

        val Superlative = Model(
            fwd = """
                1st:e
                ¦1est:l,m,f,s
                ¦1iest:cey
                ¦2est:or,ir
                ¦3est:ver
            """.trimIndent(),
            both = """
                4:east
                ¦5:hwest
                ¦5lest:erful
                ¦4est:weet,lgar,tter,oung
                ¦4most:uter
                ¦3est:ger,der,rey,iet,ong,ear
                ¦3test:lat
                ¦3most:ner
                ¦2est:pt,ft,nt,ct,rt,ht
                ¦2test:it
                ¦2gest:ig
                ¦1est:b,k,n,p,h,d,w
                ¦iest:y
            """.trimIndent(),
            rev = """
                1:ttest,nnest,yest
                ¦2:sest,stest,rmest,cest,vest,lmest,olest,ilest,ulest,ssest,imest,uest
                ¦3:rgest,eatest,oorest,plest,allest,urest,iefest,uelest,blest,ugest,amest,yalest,ealest,illest,tlest,itest
                ¦4:cerest,eriest,somest,rmalest,ndomest,motest,uarest,tiffest
                ¦5:leverest,rangest
                ¦ar:urthest
                ¦3ey:riciest
            """.trimIndent(),
            ex = """
                best:good
                ¦worst:bad
                ¦5est:great
                ¦4est:fast,full,fair,dull
                ¦3test:hot,wet,fat
                ¦4nest:thin
                ¦1urthest:far
                ¦3est:gay,shy,ill
                ¦4test:neat
                ¦4st:late,wide,fine,safe,cute,fake,pale,rare,rude,sore,ripe,dire
                ¦6st:severe
            """.trimIndent(),
        )
    }
}
