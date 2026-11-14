/**
 * Layout geometry that follows params (L2.5): geometry values may be arithmetic expressions over the numeric params,
 * the geometry `vars` and `aspect` (the capture's width / height); parseManifest checks them, evalLayoutGeometry
 * evaluates them for one use (the planner does it for every layout use).
 */
import { describe, expect, it } from 'vitest';
import { GeometryExpressionError, evalGeometryValue, evalLayoutGeometry, expressionIdentifiers, geometryIsDynamic, geometryScope, parseManifest } from '@retake/components';
import type { LayoutGeometrySpec } from '@retake/components';

const fmt = (issues: Array<{ line?: number; col?: number; severity: string; path: Array<string | number>; message: string }>) =>
  issues.map((i) => `${i.line}:${i.col} ${i.severity} ${i.path.join('.')}: ${i.message}`).join('\n');

function layout(geometry: string, params = '    width: {type: number, minimum: 400, maximum: 1920, default: 1560}\n'): string {
  return [
    'id: acme/card',
    'version: 1.0.0',
    'kind: layout',
    'name: Card',
    'description: A card.',
    'params:',
    '  type: object',
    '  properties:',
    params.trimEnd(),
    '    tone: {type: string, enum: [light, dark], default: light}',
    '    framed: {type: boolean, default: true}',
    'geometry:',
    geometry.trimEnd(),
    '',
  ].join('\n');
}

describe('geometry expressions', () => {
  it('evaluates + - * / %, parentheses, unary minus, min/max/round/floor/ceil/abs over the scope', () => {
    const scope = { width: 1560, aspect: 16 / 9, framed: 1 };
    expect(evalGeometryValue('(1920 - width) / 2', scope)).toBe(180);
    expect(evalGeometryValue('round(width / aspect)', scope)).toBe(878);
    expect(evalGeometryValue('min(width, floor(878 * aspect), 2000)', scope)).toBe(1560);
    expect(evalGeometryValue('max(-5, abs(-3) * 2) + 7 % 4 - ceil(0.2)', scope)).toBe(8);
    expect(evalGeometryValue('-width + +20', scope)).toBe(-1540);
    expect(evalGeometryValue('framed * 10', scope)).toBe(10);
    expect(evalGeometryValue(12.5, scope)).toBe(12.5);
    expect(expressionIdentifiers('round((1920 - w) / 2) + max(x, aspect)').sort()).toEqual(['aspect', 'w', 'x']);
  });

  it('rejects anything else with the position of the problem', () => {
    const err = (src: string) => {
      try {
        evalGeometryValue(src, { width: 1 });
        return '';
      } catch (e) {
        expect(e).toBeInstanceOf(GeometryExpressionError);
        return (e as Error).message;
      }
    };
    expect(err('width +')).toMatch(/unexpected end of expression/);
    expect(err('width ** 2')).toMatch(/unexpected "\*" at 8/);
    expect(err('pow(width, 2)')).toMatch(/unknown function "pow"/);
    expect(err('round(1, 2)')).toMatch(/round\(\) takes one argument/);
    expect(err('min()')).toMatch(/min\(\) takes at least one argument/);
    expect(err('width.x')).toMatch(/unexpected character "\."/);
    expect(err('"a"')).toMatch(/unexpected character/);
    expect(err('height')).toMatch(/unknown name "height" at 1/);
    expect(err('width / 0')).toMatch(/not a finite number/);
  });

  it('scope: numeric params as they are, booleans as 1 / 0, others left out; aspect built in (16:9 by default)', () => {
    expect(geometryScope({ width: 1400, framed: false, tone: 'dark', list: [1] })).toEqual({ width: 1400, framed: 0, aspect: 16 / 9, aspect2: 16 / 9 });
    expect(geometryScope({}, 1.6).aspect).toBe(1.6);
    expect(geometryScope({}, Number.NaN).aspect).toBe(16 / 9);
    // L2.11: `aspect2` is the second page's aspect (multi-page layouts), the first one's when there is none.
    expect(geometryScope({}, 1.6, 390 / 844).aspect2).toBe(390 / 844);
    expect(geometryScope({}, 1.6).aspect2).toBe(1.6);
  });

  it('evalLayoutGeometry: vars in order, every rect and the radius; static geometries pass through', () => {
    const spec: LayoutGeometrySpec = {
      vars: { h: 'round(width / aspect)', y: 'round((958 - h) / 2)' },
      screen: { x: '(1920 - width) / 2', y: 'y', w: 'width', h: 'h' },
      caption: { x: '(1920 - width) / 2', y: 'y + h + 12', w: 'width - 340', h: 110 },
      radius: 'radius * 2',
    };
    expect(evalLayoutGeometry(spec, { width: 1400, radius: 9 })).toEqual({
      screen: { x: 260, y: 85, w: 1400, h: 788 },
      caption: { x: 260, y: 885, w: 1060, h: 110 },
      radius: 18,
    });
    expect(evalLayoutGeometry(spec, { width: 1400, radius: 9 }, { aspect: 2 }).screen.h).toBe(700);
    expect(() => evalLayoutGeometry(spec, { width: 1400 })).toThrow(/radius: unknown name "radius"/);
    expect(geometryIsDynamic(spec)).toBe(true);
    const fixed: LayoutGeometrySpec = { screen: { x: 0, y: 0, w: 1920, h: 1080 }, radius: 0 };
    expect(geometryIsDynamic(fixed)).toBe(false);
    expect(evalLayoutGeometry(fixed)).toEqual({ screen: { x: 0, y: 0, w: 1920, h: 1080 }, radius: 0 });
  });
});

describe('component.yaml geometry checks', () => {
  it('accepts expressions over numeric/boolean params, earlier vars and aspect', () => {
    const r = parseManifest(
      layout(`  vars:
    h: min(round(width / aspect), 878)
    x: round((1920 - width) / 2)
  screen: {x: x, y: 40, w: width, h: h}
  caption: {x: x, y: 40 + h + 12, w: width - 340 * framed, h: 110}`),
    );
    expect(fmt(r.issues)).toBe('');
    expect(r.manifest?.geometry?.screen).toEqual({ x: 'x', y: 40, w: 'width', h: 'h' });
  });

  it('positioned errors: syntax, unknown names (did you mean), string params, shadowing vars, aspect as a var', () => {
    const issues = fmt(
      parseManifest(
        layout(`  vars:
    w: widht * 2
    tone: 3
    aspect: 2
  screen: {x: (1920 - width / 2, y: tone, w: w, h: 100}`),
      ).issues,
    );
    expect(issues).toMatch(/14:\d+ error geometry\.vars\.w: unknown name "widht" in "widht \* 2" \(did you mean "width"\?\)/);
    expect(issues).toMatch(/15:\d+ error geometry\.vars\.tone: var "tone" has the name of a param/);
    expect(issues).toMatch(/16:\d+ error geometry\.vars\.aspect: "aspect" is built in/);
    expect(issues).toMatch(/17:\d+ error geometry\.screen\.x: invalid expression "\(1920 - width \/ 2": expected "\)"/);
    const stringParam = fmt(parseManifest(layout('  screen: {x: 0, y: tone, w: 100, h: 100}')).issues);
    expect(stringParam).toMatch(/13:\d+ error geometry\.screen\.y: "tone" is a string param: expressions only use number, integer or boolean params/);
  });

  it('evaluated with the param defaults (capture 16:9): positive sizes, inside the design space', () => {
    const outside = fmt(parseManifest(layout('  screen: {x: (1920 - width) / 2, y: 300, w: width, h: width * 9 / 16}')).issues);
    expect(outside).toMatch(/13:\d+ error geometry\.screen: screen rect \{x: 180, y: 300, w: 1560, h: 877\.5\} \(with the param defaults, capture 16:9\) leaves the 1920×1080 design space/);
    const negative = fmt(parseManifest(layout('  screen: {x: 0, y: 0, w: 1000 - width, h: 100}')).issues);
    expect(negative).toMatch(/error geometry\.screen\.w: must be > 0, is -560 \(with the param defaults, capture 16:9\)/);
    const radius = fmt(parseManifest(layout('  screen: {x: 0, y: 0, w: 100, h: 100}\n  radius: 10 - width')).issues);
    expect(radius).toMatch(/error geometry\.radius: must be ≥ 0, is -1550/);
  });
});
