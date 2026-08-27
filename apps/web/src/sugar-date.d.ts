declare module "sugar-date/index.js" {
  interface DateCreateOptions {
    locale?: string;
    future?: boolean;
  }

  interface SugarDateNamespace {
    create(value: string, options?: DateCreateOptions): Date;
    getOption<T>(name: string): T;
    setOption(name: string, value: unknown): void;
  }

  const Sugar: {
    Date: SugarDateNamespace;
  };

  export default Sugar;
}
