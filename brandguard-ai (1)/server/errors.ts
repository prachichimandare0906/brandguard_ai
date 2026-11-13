export class ConfigurationError extends Error {
  status = 500;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class DatabaseUnavailableError extends Error {
  status = 503;
  constructor(message = 'Database service is temporarily unavailable.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
  }
}

export class StorageUnavailableError extends Error {
  status = 503;
  constructor(message = 'Document storage service is temporarily unavailable.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageUnavailableError';
  }
}
