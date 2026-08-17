import React from "react";

/**
 * Sem isto, uma excecao em QUALQUER canto da interface desmonta a arvore
 * inteira e sobra uma pagina preta, sem mensagem — foi exatamente o que um
 * `creditIds` nao declarado no catalogo fez com o estudio todo.
 *
 * Com um limite por workspace, o estrago fica do tamanho do defeito: a aba
 * quebrada vira um cartao com o erro, e o resto continua utilizavel.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // O console continua sendo a fonte da pilha completa; o cartao mostra so o
    // suficiente para a pessoa saber o que quebrou e reportar.
    console.error(`[bench] ${this.props.name ?? "workspace"} failed to render`, error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="view-page error-card" role="alert">
        <h2>{this.props.name ?? "This workspace"} could not be displayed.</h2>
        <p>The rest of the studio is still working — switch to another tab and carry on.</p>
        <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </section>
    );
  }
}
