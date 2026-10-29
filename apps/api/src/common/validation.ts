import { BadRequestException } from '@nestjs/common';
import { z, ZodTypeAny } from 'zod';

/** Parse a request body with a zod schema (defaults applied); 400 with field errors on failure. */
export function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
