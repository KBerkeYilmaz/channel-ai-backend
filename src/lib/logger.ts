// Simple console-based logger that won't have worker thread issues
const createSimpleLogger = () => {
  const timestamp = () => new Date().toISOString();

  return {
    info: (data: Record<string, unknown>, message?: string) => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[${timestamp()}] INFO:`, message ?? '', data);
      }
    },
    error: (data: Record<string, unknown>, message?: string) => {
      console.error(`[${timestamp()}] ERROR:`, message ?? '', data);
    },
    warn: (data: Record<string, unknown>, message?: string) => {
      console.warn(`[${timestamp()}] WARN:`, message ?? '', data);
    },
    debug: (data: Record<string, unknown>, message?: string) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.debug(`[${timestamp()}] DEBUG:`, message ?? '', data);
      }
    },
    trace: (data: Record<string, unknown>, message?: string) => {
      if (process.env.LOG_LEVEL === 'trace') {
        console.trace(`[${timestamp()}] TRACE:`, message ?? '', data);
      }
    },
    child: (_bindings: Record<string, unknown>) => {
      return createSimpleLogger(); // Return same logger for simplicity
    }
  };
};

const logger = createSimpleLogger();

// Enhanced logging methods with context
export const createLogger = (context: string) => {
  return {
    info: (message: string, data?: Record<string, unknown>) => {
      logger.info({ context, ...data }, message);
    },
    error: (message: string, error?: unknown, data?: Record<string, unknown>) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.error({
        context,
        error: errorMessage,
        stack: errorStack,
        ...data
      }, message);
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      logger.warn({ context, ...data }, message);
    },
    debug: (message: string, data?: Record<string, unknown>) => {
      logger.debug({ context, ...data }, message);
    },
    trace: (message: string, data?: Record<string, unknown>) => {
      logger.trace({ context, ...data }, message);
    },
    child: (bindings: Record<string, unknown>) => {
      return createLogger(`${context}:${Object.keys(bindings)[0] ?? 'child'}`);
    }
  };
};

export default logger;