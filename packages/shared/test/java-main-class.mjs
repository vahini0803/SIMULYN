// Regression tests for detectJavaMainClass.
//
// The bug these exist for: the generated harness driver declares a nested
// `static class J` helper inside `Main`, above `main`. Picking the last class
// declared before `main` chose `J`, so `java -cp <dir> J` failed with
// ClassNotFoundException on every test case — a correct Java solution scored 0.
// It went unnoticed because no JDK is installed on the development machine, so
// Java submissions never got past "runtime not installed" locally.
import { buildProgram, detectJavaMainClass } from '../dist/execution/index.js';

let pass = 0;
let fail = 0;

const check = (name, actual, expected) => {
  if (actual === expected) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

console.log('\n── the driver the harness actually generates');

const spec = {
  funcName: 'twoSum',
  params: [
    { name: 'nums', type: 'intArray' },
    { name: 'target', type: 'int' },
  ],
  returnType: 'intArray',
};
const student = 'class Solution {\n    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }\n}';
const driver = buildProgram('java', student, spec);

check('launches Main, not the nested helper', detectJavaMainClass(driver), 'Main');
check('the nested helper really is in there', /static\s+class\s+J\b/.test(driver), true);

console.log('\n── free-form snippets (Run mode)');

check(
  'plain class holding main',
  detectJavaMainClass('class Solution { public static void main(String[] a){} }'),
  'Solution',
);
check(
  'public class with another name',
  detectJavaMainClass('public class Runner { public static void main(String[] a){} }'),
  'Runner',
);
check(
  'several top-level classes',
  detectJavaMainClass('class A {}\nclass B {}\npublic class Main { public static void main(String[] a){} }'),
  'Main',
);
check(
  'main declared as static public void',
  detectJavaMainClass('public class Main { static public void main(String[] a){} }'),
  'Main',
);
check('no main at all', detectJavaMainClass('class Solution { int f(){ return 1; } }'), null);

console.log('\n── braces that must not be counted');

check(
  'brace inside a string literal',
  detectJavaMainClass('public class Main { String s = "{"; static class J {} public static void main(String[] a){} }'),
  'Main',
);
check(
  'brace inside a char literal',
  detectJavaMainClass("public class Main { char c = '{'; static class J {} public static void main(String[] a){} }"),
  'Main',
);
check(
  'brace inside a line comment',
  detectJavaMainClass('public class Main { // {\n static class J {} public static void main(String[] a){} }'),
  'Main',
);
check(
  'brace inside a block comment',
  detectJavaMainClass('public class Main { /* { { */ static class J {} public static void main(String[] a){} }'),
  'Main',
);
check(
  'escaped quote does not end the string',
  detectJavaMainClass('public class Main { String s = "\\"{"; static class J {} public static void main(String[] a){} }'),
  'Main',
);

console.log('\n── nesting');

check(
  'helper nested two deep',
  detectJavaMainClass('public class Main { static class J { static class K {} } public static void main(String[] a){} }'),
  'Main',
);
check(
  'top-level class after a nested one still wins',
  detectJavaMainClass('class A { class Inner {} }\npublic class Main { public static void main(String[] a){} }'),
  'Main',
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
