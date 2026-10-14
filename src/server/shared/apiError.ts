export class ApiError extends Error {
  statusCode: number;
  code: string;
  category: string;
  userMessage?: string;

  constructor(statusCode: number, code: string, category: string, message: string, userMessage?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.category = category;
    this.userMessage = userMessage;
  }
}
