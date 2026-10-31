import { writeFileSync } from 'node:fs';
import { createVitest } from 'vitest/node';

const runner = await createVitest('test', { watch: false, reporters: [] });
try {
  const specifications = await runner.globTestSpecifications();
  const { testModules, unhandledErrors } = await runner.collectTests(specifications);
  if (process.exitCode || unhandledErrors.length || testModules.length !== specifications.length) {
    throw new Error('Vitest could not collect all tests');
  }
  const cases = [];
  for (const module of testModules) {
    for (const item of module.children.allTests()) {
      const names = [item.name];
      let parent = item.parent;
      while (parent.type === 'suite') {
        names.unshift(parent.name);
        parent = parent.parent;
      }
      cases.push({
        file: module.moduleId,
        name: names.join(' > '),
        skipped: item.result().state !== 'pending',
      });
    }
  }
  writeFileSync(process.argv[2], JSON.stringify(cases));
} finally {
  await runner.close();
}
