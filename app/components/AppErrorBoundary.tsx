"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { APP_NAME, APP_VERSION } from "../lib/appVersion";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${APP_NAME} client error`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-fallback" role="alert">
          <div>
            <span className="eyebrow">{APP_NAME.toUpperCase()} {APP_VERSION}</span>
            <h1>The viewer could not start</h1>
            <p>{this.state.error.message}</p>
            <button
              className="button primary"
              onClick={() => window.location.reload()}
            >
              Reload viewer
            </button>
            <small>
              No MCT data was uploaded. If this repeats, copy the message above
              and send it back to us.
            </small>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
