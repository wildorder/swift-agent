import { tool } from '@swiftagent/sdk';
import { z } from 'zod';

/**
 * Safe recursive-descent arithmetic evaluator. Supports numbers (incl.
 * decimals), + - * / %, unary minus, and parentheses. NEVER uses eval — the
 * expression is tokenized and parsed by hand, and anything unexpected throws.
 */
export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    const token = tokens[pos];
    if (token === undefined) {
      throw new Error('Unexpected end of expression.');
    }
    pos += 1;
    return token;
  }

  // expr := term (('+' | '-') term)*
  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  // term := factor (('*' | '/' | '%') factor)*
  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const rhs = parseFactor();
      if (op === '*') value = value * rhs;
      else if (op === '/') {
        if (rhs === 0) throw new Error('Division by zero.');
        value = value / rhs;
      } else {
        if (rhs === 0) throw new Error('Modulo by zero.');
        value = value % rhs;
      }
    }
    return value;
  }

  // factor := '-' factor | primary
  function parseFactor(): number {
    if (peek() === '-') {
      consume();
      return -parseFactor();
    }
    return parsePrimary();
  }

  // primary := number | '(' expr ')'
  function parsePrimary(): number {
    const token = consume();
    if (token === '(') {
      const value = parseExpr();
      if (consume() !== ')') {
        throw new Error('Expected a closing parenthesis.');
      }
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new Error(`Unexpected token "${token}" in expression.`);
    }
    return value;
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new Error(`Unexpected token "${tokens[pos] ?? ''}" in expression.`);
  }
  if (!Number.isFinite(result)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  return result;
}

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if ('+-*/%()'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expression.length && /[0-9.]/.test(expression[j] as string)) {
        j += 1;
      }
      tokens.push(expression.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression.`);
  }
  if (tokens.length === 0) {
    throw new Error('Expression is empty.');
  }
  return tokens;
}

/**
 * A fast in-process tool for duration contrast with the network-bound weather
 * tool. The evaluator above is a hand-written parser — never eval().
 */
export const calculateTool = tool({
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression (numbers, + - * / %, parentheses). Safe parser, no code execution.',
  inputSchema: z.object({
    expression: z.string().min(1).max(200),
  }),
  execute: async ({ expression }) => {
    return { expression, result: evaluateExpression(expression) };
  },
});
