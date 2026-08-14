import type { LangKey } from './executor';
import { normaliseJavaSource } from './executor';

/**
 * Builds a complete, compilable program around a student's function.
 *
 * Wire format (matches the seeded problem bank):
 *   TestCase.input    — one JSON literal per line, in `params` order
 *   TestCase.expected — a single JSON literal matching `returnType`
 *
 * Linked lists arrive as a JSON array of values; binary trees as a level-order
 * array with `null` for missing children. The driver parses stdin, calls the
 * student's function and prints the result back as one JSON literal, so the
 * comparison in execution.service can be structural rather than textual.
 */

export type HarnessType =
  | 'int'
  | 'double'
  | 'string'
  | 'bool'
  | 'intArray'
  | 'stringArray'
  | 'listNode'
  | 'treeNode'
  | 'grid';

export interface HarnessParam {
  name: string;
  type: HarnessType;
}

export interface HarnessSpec {
  funcName: string;
  params: HarnessParam[];
  returnType: HarnessType;
  funcNameByLang?: Partial<Record<LangKey, string>>;
  normalize?: 'sortArray' | 'sortRows';
}

export class HarnessError extends Error {}

/**
 * The driver prints the return value after this marker, so a student's own
 * `print()` calls stay out of the graded comparison. Anything before it is
 * their debug output and is shown back to them untouched.
 */
export const RESULT_MARKER = '__SIMULYN_RESULT__';

const HARNESS_TYPES: HarnessType[] = [
  'int',
  'double',
  'string',
  'bool',
  'intArray',
  'stringArray',
  'listNode',
  'treeNode',
  'grid',
];

/** Validates a harness read out of the database before we generate code from it. */
export function assertValidHarness(spec: unknown): asserts spec is HarnessSpec {
  if (!spec || typeof spec !== 'object') throw new HarnessError('This problem has no harness definition');

  const s = spec as Partial<HarnessSpec>;
  if (!s.funcName || typeof s.funcName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(s.funcName)) {
    throw new HarnessError('harness.funcName is missing or not a valid identifier');
  }
  if (!Array.isArray(s.params)) throw new HarnessError('harness.params must be an array');
  for (const p of s.params) {
    if (!p || typeof p.name !== 'string' || !HARNESS_TYPES.includes(p.type)) {
      throw new HarnessError(`Unsupported harness parameter: ${JSON.stringify(p)}`);
    }
  }
  if (!HARNESS_TYPES.includes(s.returnType as HarnessType)) {
    throw new HarnessError(`Unsupported harness return type: ${String(s.returnType)}`);
  }
}

function funcNameFor(spec: HarnessSpec, lang: LangKey): string {
  return spec.funcNameByLang?.[lang] ?? spec.funcName;
}

/** A string literal that is valid in all four target languages. */
function literal(value: string): string {
  return JSON.stringify(value);
}

// ───────────────────────────────────────────────────────── Python ──

const PY_PRELUDE = `import json, sys
from collections import deque

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

def _simulyn_build_list(arr):
    head = tail = None
    for v in (arr or []):
        node = ListNode(v)
        if head is None:
            head = tail = node
        else:
            tail.next = node
            tail = node
    return head

def _simulyn_dump_list(node):
    out = []
    seen = 0
    while node is not None and seen < 100000:
        out.append(node.val)
        node = node.next
        seen += 1
    return out

def _simulyn_build_tree(arr):
    if not arr:
        return None
    root = TreeNode(arr[0])
    q = deque([root])
    i = 1
    while q and i < len(arr):
        node = q.popleft()
        if i < len(arr):
            v = arr[i]; i += 1
            if v is not None:
                node.left = TreeNode(v); q.append(node.left)
        if i < len(arr):
            v = arr[i]; i += 1
            if v is not None:
                node.right = TreeNode(v); q.append(node.right)
    return root

def _simulyn_dump_tree(node):
    if node is None:
        return []
    out = []
    q = deque([node])
    while q:
        n = q.popleft()
        if n is None:
            out.append(None)
            continue
        out.append(n.val)
        q.append(n.left)
        q.append(n.right)
    while out and out[-1] is None:
        out.pop()
    return out
`;

function pythonArg(type: HarnessType, index: number): string {
  const raw = `_simulyn_arg(${index})`;
  if (type === 'listNode') return `_simulyn_build_list(${raw})`;
  if (type === 'treeNode') return `_simulyn_build_tree(${raw})`;
  return raw;
}

function pythonResult(type: HarnessType): string {
  if (type === 'listNode') return '_simulyn_dump_list(_simulyn_res)';
  if (type === 'treeNode') return '_simulyn_dump_tree(_simulyn_res)';
  return '_simulyn_res';
}

function buildPython(userCode: string, spec: HarnessSpec, testInput?: string): string {
  const fn = funcNameFor(spec, 'python');
  const args = spec.params.map((p, i) => pythonArg(p.type, i)).join(', ');
  const input =
    testInput === undefined ? 'sys.stdin.read()' : literal(testInput);

  return `${PY_PRELUDE}
# ── student code ──
${userCode}
# ── driver ──

def _simulyn_main():
    _raw = ${input}
    _lines = _raw.replace('\\r\\n', '\\n').replace('\\r', '\\n').split('\\n')

    def _simulyn_arg(i):
        if i >= len(_lines) or _lines[i].strip() == '':
            return None
        return json.loads(_lines[i])

    _g = globals()
    _fn = _g.get(${literal(fn)})
    if not callable(_fn):
        _cls = _g.get('Solution')
        _fn = getattr(_cls(), ${literal(fn)}, None) if _cls is not None else None
    if not callable(_fn):
        sys.stderr.write("Could not find a function named '${fn}'.\\n")
        sys.exit(2)

    _simulyn_res = _fn(${args})
    sys.stdout.write('\\n${RESULT_MARKER}')
    sys.stdout.write(json.dumps(${pythonResult(spec.returnType)}, separators=(',', ':')))
    sys.stdout.write('\\n')

_simulyn_main()
`;
}

// ───────────────────────────────────────────────────── JavaScript ──

const JS_PRELUDE = `'use strict';
function ListNode(val, next) { this.val = val === undefined ? 0 : val; this.next = next === undefined ? null : next; }
function TreeNode(val, left, right) {
  this.val = val === undefined ? 0 : val;
  this.left = left === undefined ? null : left;
  this.right = right === undefined ? null : right;
}

function _simulynBuildList(arr) {
  let head = null, tail = null;
  for (const v of arr || []) {
    const node = new ListNode(v);
    if (!head) { head = node; tail = node; } else { tail.next = node; tail = node; }
  }
  return head;
}

function _simulynDumpList(node) {
  const out = [];
  let guard = 0;
  while (node && guard++ < 100000) { out.push(node.val); node = node.next; }
  return out;
}

function _simulynBuildTree(arr) {
  if (!arr || arr.length === 0) return null;
  const root = new TreeNode(arr[0]);
  const q = [root];
  let i = 1, head = 0;
  while (head < q.length && i < arr.length) {
    const node = q[head++];
    if (i < arr.length) { const v = arr[i++]; if (v !== null && v !== undefined) { node.left = new TreeNode(v); q.push(node.left); } }
    if (i < arr.length) { const v = arr[i++]; if (v !== null && v !== undefined) { node.right = new TreeNode(v); q.push(node.right); } }
  }
  return root;
}

function _simulynDumpTree(node) {
  if (!node) return [];
  const out = [], q = [node];
  let head = 0;
  while (head < q.length) {
    const n = q[head++];
    if (!n) { out.push(null); continue; }
    out.push(n.val); q.push(n.left); q.push(n.right);
  }
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}
`;

function jsArg(type: HarnessType, index: number): string {
  const raw = `_simulynArg(${index})`;
  if (type === 'listNode') return `_simulynBuildList(${raw})`;
  if (type === 'treeNode') return `_simulynBuildTree(${raw})`;
  return raw;
}

function jsResult(type: HarnessType): string {
  if (type === 'listNode') return '_simulynDumpList(_simulynRes)';
  if (type === 'treeNode') return '_simulynDumpTree(_simulynRes)';
  return '_simulynRes';
}

function buildJavaScript(userCode: string, spec: HarnessSpec, testInput?: string): string {
  const fn = funcNameFor(spec, 'javascript');
  const args = spec.params.map((p, i) => jsArg(p.type, i)).join(', ');
  const input =
    testInput === undefined
      ? `(() => { try { return require('fs').readFileSync(0, 'utf8'); } catch (e) { return ''; } })()`
      : literal(testInput);

  return `${JS_PRELUDE}
// ── student code ──
${userCode}
// ── driver ──
(function () {
  const _raw = ${input};
  const _lines = _raw.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').split('\\n');

  function _simulynArg(i) {
    if (i >= _lines.length || _lines[i].trim() === '') return null;
    return JSON.parse(_lines[i]);
  }

  let _fn = null;
  if (typeof ${fn} === 'function') {
    _fn = ${fn};
  } else if (typeof Solution === 'function') {
    const _s = new Solution();
    if (typeof _s.${fn} === 'function') _fn = _s.${fn}.bind(_s);
  }
  if (!_fn) {
    process.stderr.write("Could not find a function named '${fn}'.\\n");
    process.exit(2);
  }

  const _simulynRes = _fn(${args});
  process.stdout.write('\\n${RESULT_MARKER}' + JSON.stringify(${jsResult(spec.returnType)}) + '\\n');
})();
`;
}

// ──────────────────────────────────────────────────────────── C++ ──

const CPP_PRELUDE = `#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
#include <sstream>
#include <stack>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
using namespace std;

struct ListNode {
    int val; ListNode *next;
    ListNode() : val(0), next(nullptr) {}
    ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode *n) : val(x), next(n) {}
};

struct TreeNode {
    int val; TreeNode *left; TreeNode *right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(int x, TreeNode *l, TreeNode *r) : val(x), left(l), right(r) {}
};

namespace simulyn {

struct JV {
    int t = 0;              // 0 null, 1 number, 2 string, 3 bool, 4 array
    double num = 0;
    string str;
    bool bl = false;
    vector<JV> arr;
};

inline void skipWs(const string &s, size_t &i) {
    while (i < s.size() && isspace((unsigned char)s[i])) i++;
}

inline JV parse(const string &s, size_t &i) {
    JV v;
    skipWs(s, i);
    if (i >= s.size()) return v;
    char c = s[i];
    if (c == '[') {
        v.t = 4; i++; skipWs(s, i);
        if (i < s.size() && s[i] == ']') { i++; return v; }
        while (i < s.size()) {
            v.arr.push_back(parse(s, i));
            skipWs(s, i);
            if (i < s.size() && s[i] == ',') { i++; continue; }
            if (i < s.size() && s[i] == ']') { i++; }
            break;
        }
        return v;
    }
    if (c == '"') {
        v.t = 2; i++;
        string out;
        while (i < s.size() && s[i] != '"') {
            if (s[i] == '\\\\' && i + 1 < s.size()) {
                i++;
                char e = s[i++];
                if (e == 'n') out += '\\n';
                else if (e == 't') out += '\\t';
                else if (e == 'r') out += '\\r';
                else out += e;
            } else {
                out += s[i++];
            }
        }
        if (i < s.size()) i++;
        v.str = out;
        return v;
    }
    if (s.compare(i, 4, "true") == 0) { v.t = 3; v.bl = true; i += 4; return v; }
    if (s.compare(i, 5, "false") == 0) { v.t = 3; v.bl = false; i += 5; return v; }
    if (s.compare(i, 4, "null") == 0) { v.t = 0; i += 4; return v; }
    size_t start = i;
    while (i < s.size() && (isdigit((unsigned char)s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
    v.t = 1;
    v.num = atof(s.substr(start, i - start).c_str());
    return v;
}

inline JV parseLine(const string &line) { size_t i = 0; return parse(line, i); }

inline int asInt(const JV &v) { return (int)llround(v.num); }
inline double asDouble(const JV &v) { return v.num; }
inline bool asBool(const JV &v) { return v.t == 3 ? v.bl : v.num != 0; }
inline string asStr(const JV &v) { return v.str; }

inline vector<int> asIntArr(const JV &v) {
    vector<int> r;
    for (const auto &e : v.arr) r.push_back(asInt(e));
    return r;
}

inline vector<string> asStrArr(const JV &v) {
    vector<string> r;
    for (const auto &e : v.arr) r.push_back(e.t == 2 ? e.str : to_string((long long)llround(e.num)));
    return r;
}

inline vector<vector<string>> asGrid(const JV &v) {
    vector<vector<string>> r;
    for (const auto &row : v.arr) r.push_back(asStrArr(row));
    return r;
}

inline ListNode *asList(const JV &v) {
    ListNode *head = nullptr, *tail = nullptr;
    for (const auto &e : v.arr) {
        ListNode *n = new ListNode(asInt(e));
        if (!head) { head = tail = n; } else { tail->next = n; tail = n; }
    }
    return head;
}

inline TreeNode *asTree(const JV &v) {
    if (v.arr.empty()) return nullptr;
    TreeNode *root = new TreeNode(asInt(v.arr[0]));
    queue<TreeNode *> q; q.push(root);
    size_t i = 1;
    while (!q.empty() && i < v.arr.size()) {
        TreeNode *n = q.front(); q.pop();
        if (i < v.arr.size()) { const JV &e = v.arr[i++]; if (e.t != 0) { n->left = new TreeNode(asInt(e)); q.push(n->left); } }
        if (i < v.arr.size()) { const JV &e = v.arr[i++]; if (e.t != 0) { n->right = new TreeNode(asInt(e)); q.push(n->right); } }
    }
    return root;
}

inline string esc(const string &s) {
    string o;
    for (char c : s) {
        if (c == '"' || c == '\\\\') { o += '\\\\'; o += c; }
        else if (c == '\\n') o += "\\\\n";
        else if (c == '\\t') o += "\\\\t";
        else if (c == '\\r') o += "\\\\r";
        else o += c;
    }
    return o;
}

inline string toJson(bool v) { return v ? "true" : "false"; }
inline string toJson(int v) { return to_string(v); }
inline string toJson(long long v) { return to_string(v); }
inline string toJson(double v) {
    ostringstream o; o << setprecision(12) << v; return o.str();
}
inline string toJson(const string &v) { return "\\"" + esc(v) + "\\""; }
inline string toJson(const char *v) { return toJson(string(v)); }

inline string toJson(const vector<int> &v) {
    string o = "[";
    for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += to_string(v[i]); }
    return o + "]";
}

inline string toJson(const vector<string> &v) {
    string o = "[";
    for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += toJson(v[i]); }
    return o + "]";
}

inline string toJson(const vector<vector<string>> &v) {
    string o = "[";
    for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += toJson(v[i]); }
    return o + "]";
}

inline string toJson(const vector<vector<int>> &v) {
    string o = "[";
    for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += toJson(v[i]); }
    return o + "]";
}

inline string toJson(ListNode *n) {
    string o = "[";
    int guard = 0;
    while (n && guard++ < 100000) { if (guard > 1) o += ","; o += to_string(n->val); n = n->next; }
    return o + "]";
}

inline string toJson(TreeNode *root) {
    if (!root) return "[]";
    vector<string> out;
    queue<TreeNode *> q; q.push(root);
    while (!q.empty()) {
        TreeNode *n = q.front(); q.pop();
        if (!n) { out.push_back("null"); continue; }
        out.push_back(to_string(n->val));
        q.push(n->left); q.push(n->right);
    }
    while (!out.empty() && out.back() == "null") out.pop_back();
    string o = "[";
    for (size_t i = 0; i < out.size(); i++) { if (i) o += ","; o += out[i]; }
    return o + "]";
}

}  // namespace simulyn
`;

function cppArg(type: HarnessType, index: number): string {
  const raw = `simulyn::parseLine(_simulyn_line(${index}))`;
  switch (type) {
    case 'int':
      return `simulyn::asInt(${raw})`;
    case 'double':
      return `simulyn::asDouble(${raw})`;
    case 'string':
      return `simulyn::asStr(${raw})`;
    case 'bool':
      return `simulyn::asBool(${raw})`;
    case 'intArray':
      return `simulyn::asIntArr(${raw})`;
    case 'stringArray':
      return `simulyn::asStrArr(${raw})`;
    case 'grid':
      return `simulyn::asGrid(${raw})`;
    case 'listNode':
      return `simulyn::asList(${raw})`;
    case 'treeNode':
      return `simulyn::asTree(${raw})`;
  }
}

function buildCpp(userCode: string, spec: HarnessSpec, testInput?: string): string {
  const fn = funcNameFor(spec, 'cpp');
  const decls = spec.params
    .map((p, i) => `    auto _a${i} = ${cppArg(p.type, i)};`)
    .join('\n');
  const args = spec.params.map((_, i) => `_a${i}`).join(', ');
  const input =
    testInput === undefined
      ? `[]{ ostringstream ss; ss << cin.rdbuf(); return ss.str(); }()`
      : `string(${literal(testInput)})`;

  return `${CPP_PRELUDE}
// ── student code ──
${userCode}
// ── driver ──
int main() {
    ios::sync_with_stdio(false);
    string _raw = ${input};
    vector<string> _lines;
    {
        string cur;
        for (char c : _raw) {
            if (c == '\\n') { _lines.push_back(cur); cur.clear(); }
            else if (c != '\\r') cur += c;
        }
        _lines.push_back(cur);
    }
    auto _simulyn_line = [&](size_t i) -> string { return i < _lines.size() ? _lines[i] : string(""); };

${decls}
    Solution _sol;
    auto _res = _sol.${fn}(${args});
    cout << "\\n${RESULT_MARKER}" << simulyn::toJson(_res) << endl;
    return 0;
}
`;
}

// ─────────────────────────────────────────────────────────── Java ──

const JAVA_PRELUDE = `class ListNode {
    int val; ListNode next;
    ListNode() {}
    ListNode(int val) { this.val = val; }
    ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}

class TreeNode {
    int val; TreeNode left; TreeNode right;
    TreeNode() {}
    TreeNode(int val) { this.val = val; }
    TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }
}
`;

const JAVA_SUPPORT = `    static class J {
        int t;                 // 0 null, 1 number, 2 string, 3 bool, 4 array
        double num;
        String str = "";
        boolean bl;
        List<J> arr = new ArrayList<>();
    }

    static int _pos;

    static J parse(String s) { _pos = 0; return parseValue(s); }

    static J parseValue(String s) {
        J v = new J();
        skipWs(s);
        if (_pos >= s.length()) return v;
        char c = s.charAt(_pos);
        if (c == '[') {
            v.t = 4; _pos++; skipWs(s);
            if (_pos < s.length() && s.charAt(_pos) == ']') { _pos++; return v; }
            while (_pos < s.length()) {
                v.arr.add(parseValue(s));
                skipWs(s);
                if (_pos < s.length() && s.charAt(_pos) == ',') { _pos++; continue; }
                if (_pos < s.length() && s.charAt(_pos) == ']') _pos++;
                break;
            }
            return v;
        }
        if (c == '"') {
            v.t = 2; _pos++;
            StringBuilder sb = new StringBuilder();
            while (_pos < s.length() && s.charAt(_pos) != '"') {
                char ch = s.charAt(_pos);
                if (ch == '\\\\' && _pos + 1 < s.length()) {
                    _pos++;
                    char e = s.charAt(_pos++);
                    if (e == 'n') sb.append('\\n');
                    else if (e == 't') sb.append('\\t');
                    else if (e == 'r') sb.append('\\r');
                    else sb.append(e);
                } else { sb.append(ch); _pos++; }
            }
            if (_pos < s.length()) _pos++;
            v.str = sb.toString();
            return v;
        }
        if (s.startsWith("true", _pos)) { v.t = 3; v.bl = true; _pos += 4; return v; }
        if (s.startsWith("false", _pos)) { v.t = 3; v.bl = false; _pos += 5; return v; }
        if (s.startsWith("null", _pos)) { v.t = 0; _pos += 4; return v; }
        int start = _pos;
        while (_pos < s.length()) {
            char ch = s.charAt(_pos);
            if (Character.isDigit(ch) || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') _pos++;
            else break;
        }
        v.t = 1;
        try { v.num = Double.parseDouble(s.substring(start, _pos)); } catch (Exception ex) { v.num = 0; }
        return v;
    }

    static void skipWs(String s) {
        while (_pos < s.length() && Character.isWhitespace(s.charAt(_pos))) _pos++;
    }

    static int asInt(J v) { return (int) Math.round(v.num); }
    static double asDouble(J v) { return v.num; }
    static boolean asBool(J v) { return v.t == 3 ? v.bl : v.num != 0; }
    static String asStr(J v) { return v.str; }

    static int[] asIntArr(J v) {
        int[] r = new int[v.arr.size()];
        for (int i = 0; i < r.length; i++) r[i] = asInt(v.arr.get(i));
        return r;
    }

    static String[] asStrArr(J v) {
        String[] r = new String[v.arr.size()];
        for (int i = 0; i < r.length; i++) {
            J e = v.arr.get(i);
            r[i] = e.t == 2 ? e.str : String.valueOf((long) Math.round(e.num));
        }
        return r;
    }

    static String[][] asGrid(J v) {
        String[][] r = new String[v.arr.size()][];
        for (int i = 0; i < r.length; i++) r[i] = asStrArr(v.arr.get(i));
        return r;
    }

    static ListNode asList(J v) {
        ListNode head = null, tail = null;
        for (J e : v.arr) {
            ListNode n = new ListNode(asInt(e));
            if (head == null) { head = n; tail = n; } else { tail.next = n; tail = n; }
        }
        return head;
    }

    static TreeNode asTree(J v) {
        if (v.arr.isEmpty()) return null;
        TreeNode root = new TreeNode(asInt(v.arr.get(0)));
        Deque<TreeNode> q = new ArrayDeque<>();
        q.add(root);
        int i = 1;
        while (!q.isEmpty() && i < v.arr.size()) {
            TreeNode n = q.poll();
            if (i < v.arr.size()) { J e = v.arr.get(i++); if (e.t != 0) { n.left = new TreeNode(asInt(e)); q.add(n.left); } }
            if (i < v.arr.size()) { J e = v.arr.get(i++); if (e.t != 0) { n.right = new TreeNode(asInt(e)); q.add(n.right); } }
        }
        return root;
    }

    static String esc(String s) {
        StringBuilder o = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\\\') o.append('\\\\').append(c);
            else if (c == '\\n') o.append("\\\\n");
            else if (c == '\\t') o.append("\\\\t");
            else if (c == '\\r') o.append("\\\\r");
            else o.append(c);
        }
        return o.toString();
    }

    static String num(double d) {
        if (d == Math.rint(d) && !Double.isInfinite(d)) return String.valueOf((long) d);
        return String.valueOf(d);
    }

    /** Serialises whatever the student's method returned. */
    static String toJson(Object o) {
        if (o == null) return "null";
        if (o instanceof Boolean) return ((Boolean) o) ? "true" : "false";
        if (o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) return o.toString();
        if (o instanceof Double || o instanceof Float) return num(((Number) o).doubleValue());
        if (o instanceof Character) return "\\"" + esc(o.toString()) + "\\"";
        if (o instanceof String) return "\\"" + esc((String) o) + "\\"";
        if (o instanceof ListNode) {
            StringBuilder sb = new StringBuilder("[");
            ListNode n = (ListNode) o;
            int guard = 0;
            while (n != null && guard++ < 100000) { if (guard > 1) sb.append(','); sb.append(n.val); n = n.next; }
            return sb.append(']').toString();
        }
        if (o instanceof TreeNode) {
            List<String> out = new ArrayList<>();
            Deque<TreeNode> q = new ArrayDeque<>();
            q.add((TreeNode) o);
            while (!q.isEmpty()) {
                TreeNode n = q.poll();
                if (n == null) { out.add("null"); continue; }
                out.add(String.valueOf(n.val));
                q.add(n.left); q.add(n.right);
            }
            while (!out.isEmpty() && out.get(out.size() - 1).equals("null")) out.remove(out.size() - 1);
            return "[" + String.join(",", out) + "]";
        }
        if (o instanceof int[]) {
            int[] a = (int[]) o;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(a[i]); }
            return sb.append(']').toString();
        }
        if (o instanceof double[]) {
            double[] a = (double[]) o;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(num(a[i])); }
            return sb.append(']').toString();
        }
        if (o instanceof boolean[]) {
            boolean[] a = (boolean[]) o;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(a[i]); }
            return sb.append(']').toString();
        }
        if (o instanceof Object[]) {
            Object[] a = (Object[]) o;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(','); sb.append(toJson(a[i])); }
            return sb.append(']').toString();
        }
        if (o instanceof Collection) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object e : (Collection<?>) o) { if (!first) sb.append(','); sb.append(toJson(e)); first = false; }
            return sb.append(']').toString();
        }
        return "\\"" + esc(o.toString()) + "\\"";
    }
`;

function javaArg(type: HarnessType, index: number): { decl: string; expr: string } {
  const raw = `parse(_line(${index}))`;
  switch (type) {
    case 'int':
      return { decl: 'int', expr: `asInt(${raw})` };
    case 'double':
      return { decl: 'double', expr: `asDouble(${raw})` };
    case 'string':
      return { decl: 'String', expr: `asStr(${raw})` };
    case 'bool':
      return { decl: 'boolean', expr: `asBool(${raw})` };
    case 'intArray':
      return { decl: 'int[]', expr: `asIntArr(${raw})` };
    case 'stringArray':
      return { decl: 'String[]', expr: `asStrArr(${raw})` };
    case 'grid':
      return { decl: 'String[][]', expr: `asGrid(${raw})` };
    case 'listNode':
      return { decl: 'ListNode', expr: `asList(${raw})` };
    case 'treeNode':
      return { decl: 'TreeNode', expr: `asTree(${raw})` };
  }
}

function buildJava(userCode: string, spec: HarnessSpec, testInput?: string): string {
  const fn = funcNameFor(spec, 'java');
  const { imports, body } = normaliseJavaSource(userCode);

  const decls = spec.params
    .map((p, i) => {
      const { decl, expr } = javaArg(p.type, i);
      return `        ${decl} _a${i} = ${expr};`;
    })
    .join('\n');
  const args = spec.params.map((_, i) => `_a${i}`).join(', ');

  const readInput =
    testInput === undefined
      ? `        StringBuilder _sb = new StringBuilder();
        try (java.io.InputStreamReader _isr = new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8)) {
            char[] _buf = new char[8192];
            int _n;
            while ((_n = _isr.read(_buf)) > 0) _sb.append(_buf, 0, _n);
        }
        String _raw = _sb.toString();`
      : `        String _raw = ${literal(testInput)};`;

  const extraImports = imports.filter((i) => !i.includes('java.util.*')).join('\n');

  return `import java.util.*;
${extraImports}

${JAVA_PRELUDE}
// ── student code ──
${body}
// ── driver ──
public class Main {
${JAVA_SUPPORT}
    static String[] _lines = new String[0];

    static String _line(int i) { return i < _lines.length ? _lines[i] : ""; }

    public static void main(String[] args) throws Exception {
${readInput}
        _lines = _raw.replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n", -1);

${decls}
        Solution _sol = new Solution();
        Object _res = _sol.${fn}(${args});
        System.out.println("\\n${RESULT_MARKER}" + toJson(_res));
    }
}
`;
}

// ────────────────────────────────────────────────────────── entry ──

/**
 * @param testInput when supplied the input is baked into the program; when
 * omitted the driver reads stdin, which lets one compiled binary serve every
 * test case of a submission.
 */
export function buildProgram(
  lang: LangKey,
  userCode: string,
  spec: HarnessSpec,
  testInput?: string,
): string {
  assertValidHarness(spec);

  switch (lang) {
    case 'python':
      return buildPython(userCode, spec, testInput);
    case 'javascript':
      return buildJavaScript(userCode, spec, testInput);
    case 'cpp':
      return buildCpp(userCode, spec, testInput);
    case 'java':
      return buildJava(userCode, spec, testInput);
  }
}
