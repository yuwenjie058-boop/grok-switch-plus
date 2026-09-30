// A deliberately tiny, synthetic structure-check fixture. NOT a runnable Bot.
// Safe to parse with preflight; no proprietary bundle or credentials included.
class BasePromptBuilder {}
class BasePromptExecutor {}
function createCursorSandInference() { throw new Error('synthetic fixture only'); }
function createHostInference() { return createCursorSandInference(); }
