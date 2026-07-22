// ============================================================
// CodeActionProvider — lightbulb 快捷操作
// 选中代码后提供 Explain / Improve / Fix 操作
// ============================================================
import * as vscode from 'vscode';

export class CoordinatorCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorExtract,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (range.isEmpty) return [];

    const selection = document.getText(range);
    if (!selection.trim()) return [];

    const fileName = vscode.workspace.asRelativePath(document.uri);
    const lineInfo = `${fileName}:${range.start.line + 1}-${range.end.line + 1}`;

    const actions: vscode.CodeAction[] = [];

    // Explain Code
    const explain = new vscode.CodeAction('Coordinator: 解释代码', vscode.CodeActionKind.QuickFix);
    explain.command = {
      command: 'coordinator.codeAction',
      title: 'Explain Code',
      arguments: [{ action: 'explain', code: selection, file: lineInfo }],
    };
    actions.push(explain);

    // Improve Code
    const improve = new vscode.CodeAction('Coordinator: 优化代码', vscode.CodeActionKind.QuickFix);
    improve.command = {
      command: 'coordinator.codeAction',
      title: 'Improve Code',
      arguments: [{ action: 'improve', code: selection, file: lineInfo }],
    };
    actions.push(improve);

    // Fix Code (only when there are diagnostics)
    if (context.diagnostics.length > 0) {
      const fix = new vscode.CodeAction('Coordinator: 修复代码', vscode.CodeActionKind.QuickFix);
      fix.command = {
        command: 'coordinator.codeAction',
        title: 'Fix Code',
        arguments: [{
          action: 'fix',
          code: selection,
          file: lineInfo,
          diagnostics: context.diagnostics.map(d => d.message).join('\n'),
        }],
      };
      actions.push(fix);
    }

    // Add to Context
    const addCtx = new vscode.CodeAction('Coordinator: 添加到对话上下文', vscode.CodeActionKind.QuickFix);
    addCtx.command = {
      command: 'coordinator.addEditorContext',
      title: 'Add to Context',
      arguments: [document.uri, range],
    };
    actions.push(addCtx);

    return actions;
  }
}
