import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/**
 * RFC 9457 problem+json responses. Database constraint errors become 4xx
 * instead of leaking as 500s; unexpected errors are logged, not echoed.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: unknown = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      detail = exception.getResponse();
    } else if (typeof exception === 'object' && exception !== null && 'code' in exception) {
      const code = String((exception as { code: unknown }).code);
      const map: Record<string, [number, string]> = {
        '23505': [409, 'Duplicate record'],
        '23503': [400, 'Referenced record does not exist'],
        '23514': [400, 'Value violates a business rule'],
        '23P01': [409, 'Overlaps an existing record'],
        '22P02': [400, 'Invalid input value'],
        '42501': [403, 'Not permitted'],
      };
      if (map[code]) [status, detail] = map[code];
      else this.logger.error(exception);
    } else {
      this.logger.error(exception);
    }

    const body = typeof detail === 'object' && detail !== null ? detail : { message: detail };
    res
      .status(status)
      .type('application/problem+json')
      .json({ type: 'about:blank', status, ...(body as object) });
  }
}
