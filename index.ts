import { declare } from '@babel/helper-plugin-utils';
import {
  isModule,
  rewriteModuleStatementsAndPrepareHeader,
  isSideEffectImport,
  buildNamespaceInitStatements,
  ensureStatementsHoisted,
} from '@babel/helper-module-transforms';
import simplifyAccess from '@babel/helper-simple-access';
import { template, types as t } from '@babel/core';

export default declare((api, options) => {
  api.assertVersion(7);

  const {} = options;

  return {
    visitor: {
      Program: {
        enter(path, state) {
          const moduleExports = t.variableDeclaration('var', [
            t.variableDeclarator(
              t.identifier('module'),
              t.objectExpression([
                t.objectProperty(
                  t.identifier('exports'),
                  t.objectExpression([]),
                )
              ]),
            )
          ]);

          const defaultExport = t.exportDefaultDeclaration(
            t.memberExpression(
              t.identifier('module'),
              t.identifier('exports'),
            )
          );

          const programPath = path.scope.getProgramParent().path;
          programPath.unshiftContainer('body', moduleExports);
          programPath.pushContainer('body', defaultExport);
        }
      },

      VariableDeclarator: {
        enter(path, state) {
          const programPath = path.scope.getProgramParent().path;
          const { name } = path.node.id;

          if (name && !programPath.scope.hasBinding(name)) {
            programPath.scope.registerBinding(name, path);
          }
          else if (programPath.scope.getBinding(name)) {
            programPath.scope.getBinding(name).reference(path);
          }
        }
      },

      CallExpression: {
        enter(path, state) {
          const { node } = path;

          state.globals = state.globals || new Set();

          // Look for `require()` any renaming is assumed to be intentionally
          // done to break this kind of check, so we won't look for aliases.
          if (t.isIdentifier(node.callee) && node.callee.name === 'require') {
            // Check for nested string and template literals.
            const isString = t.isStringLiteral(node.arguments[0]);
            const isLiteral = t.isTemplateLiteral(node.arguments[0]);

            // Normalize the string value, default to the standard string
            // literal format of `{ value: "" }`.
            let str = null;

            if (isString) {
              str = <t.StringLiteral>node.arguments[0];
            }
            else if (isLiteral) {
              str = {
                value: (<t.TemplateLiteral>node.arguments[0]).quasis[0].value.raw,
              };
            }
            else {
              const str = <t.StringLiteral>node.arguments[0];

              path.parentPath.parentPath.replaceWith(
                t.expressionStatement(
                  t.callExpression(t.import(), [str])
                )
              );

              return;
            }

            const specifiers = [];

            // Convert to named import.
            if (t.isObjectPattern(path.parentPath.node.id)) {
              path.parentPath.node.id.properties.forEach(prop => {
                specifiers.push(t.importSpecifier(
                  prop.value,
                  prop.key,
                ));

                state.globals.add(prop.value.name);
              });

              const decl = t.importDeclaration(
                specifiers,
                t.stringLiteral(str.value),
              );

              path.scope.getProgramParent().path.unshiftContainer('body', decl);
              path.parentPath.remove();
            }
            // Convert to default import.
            else if (str) {
              const { parentPath } = path;
              const { left } = parentPath.node;
              const oldId = !t.isMemberExpression(left) ? left : left.id;

              // Default to the closest likely identifier.
              let id = oldId;

              // If we can't find an id, generate one from the import path.
              if (!oldId) {
                id = path.scope.generateUidIdentifier(str.value);
              }

              // Add this global name to the list.
              state.globals.add(id.name);

              // Create an import declaration.
              const decl = t.importDeclaration(
                [t.importDefaultSpecifier(id)],
                t.stringLiteral(str.value),
              );

              // Push the declaration in the root scope.
              path.scope.getProgramParent().path.unshiftContainer('body', decl);

              const { keys } = Object;

              // If we needed to generate or the change the id, then make an
              // assignment so the values stay in sync.
              if (oldId && !t.isNodesEquivalent(oldId, id)) {
                path.parentPath.parentPath.replaceWith(
                  t.expressionStatement(
                    t.assignmentExpression(
                      '=',
                      oldId,
                      id,
                    )
                  )
                );
              }
              // If we generated a new identifier for this, replace the inline
              // call with the variable.
              else if (!oldId) {
                path.replaceWith(id);
              }
              // Otherwise completely remove.
              else {
                path.parentPath.remove();
              }
            }
          }
        }
      },

      ImportDefaultSpecifier: {
        enter(path, state) {
          path.scope.getProgramParent().registerBinding(path.node.local.name, path);
        }
      },

      ImportSpecifier: {
        enter(path, state) {
          state.renamed = state.renamed || new Map();

          const { name } = path.node.local;

          // If this import was renamed, ensure the source reflects it.
          if (state.renamed.has(name)) {
            const oldName = t.identifier(name);
            const newName = t.identifier(state.renamed.get(name));

            path.replaceWith(t.importSpecifier(newName, oldName));
          }
          // Otherwise, register the final identifier.
          else {
            path.scope.getProgramParent().registerBinding(name, path);
          }
        }
      },

      AssignmentExpression: {
        enter(path, state) {
          state.globals = state.globals || new Set();
          state.renamed = state.renamed || new Map();

          // Check for module.exports.
          if (t.isMemberExpression(path.node.left)) {
            if (t.isIdentifier(path.node.left.object)) {
              // Looking at a re-exports, handled above.
              if (t.isCallExpression(path.node.right)) {
                return;
              }

              if (path.node.left.object.name === 'exports') {
                let prop = path.node.right;

                if (
                  path.scope.getProgramParent().hasBinding(prop.name) ||
                  state.globals.has(prop.name)
                ) {
                  prop = path.scope.generateUidIdentifier(prop.name);
                  state.globals.add(prop.name);
                }

                const decl =  t.exportNamedDeclaration(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(path.node.left.property, prop)
                  ]),
                  [],
                );

                // If we're in the root scope then replace the node. Otherwise
                // we cannot guarentee a named export.
                if (path.scope.path.isProgram()) {
                  // The order matters here, we need to rename first, and then
                  // replace.
                  path.scope.rename(path.node.right.name, prop.name);
                  state.renamed.set(path.node.right.name, prop.name);
                  path.parentPath.replaceWith(decl);
                }
              }
            }
          }
        }
      },
    },
  };
});
