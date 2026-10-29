import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), { bodyParser: true });
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: false });
  app.enableShutdownHooks();
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`InspectionFlow API listening on :${config.port} (auth=${config.authMode})`);
}

bootstrap();
