import { Component, ReactNode } from 'react'
import ErrorLogAction from './ErrorLogAction'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return <div role="alert" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        {this.props.fallback || <>
          <p>界面渲染出错</p>
          <p style={{ fontSize: '12px', marginTop: '8px' }}>
            {this.state.error?.message || '未知错误'}
          </p>
        </>}
        <ErrorLogAction error={this.state.error} source="renderer.error-boundary"/>
      </div>
    }

    return this.props.children
  }
}
