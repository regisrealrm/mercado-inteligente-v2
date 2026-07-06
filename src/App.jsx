import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, serverTimestamp
} from 'firebase/firestore'
import { db } from './firebase.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import {
  Plus, Check, X, Pencil, Trash2, Package, ShoppingCart,
  Camera, Loader2, Printer, Share2, Store
} from 'lucide-react'

// ============================================================
// UTILS
// ============================================================

const UNIDADES_PESO = ['kg', 'g', 'L', 'ml']

function hojeISO() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

function formatarData(iso) {
  if (!iso) return ''
  const [ano, mes, dia] = iso.split('-')
  return `${dia}/${mes}/${ano}`
}

function rotuloVariante(v) {
  if (!v.peso || v.peso === 0) return 's/ peso'
  return `${v.peso} ${v.unidadePeso}`
}

// Busca o nome atual de uma seção/item/marca pelo id, com fallback pro nome
// que ficou salvo no produto (caso o cadastro original tenha sido apagado).
function nomeAtual(lista, id, nomeFallback) {
  const item = lista.find((x) => x.id === id)
  return item ? item.nome : nomeFallback
}

function comprasNormalizadas(compras) {
  return {
    desejado: !!compras?.desejado,
    linhas: Array.isArray(compras?.linhas) ? compras.linhas : [],
    compradorId: compras?.compradorId || '',
    compradorNome: compras?.compradorNome || '',
    listaId: compras?.listaId || '',
    listaNome: compras?.listaNome || '',
    comprado: !!compras?.comprado
  }
}

function formatarLinhaQuantidade(l) {
  const partes = []
  if (l.unidades > 0) partes.push(`${l.unidades} un`)
  if (l.peso > 0) partes.push(`${l.peso} ${l.unidadePeso}`)
  return partes.join(' × ')
}

function linhasQuantidadeFormatadas(linhas) {
  if (!linhas || linhas.length === 0) return []
  return linhas.map(formatarLinhaQuantidade).filter(Boolean)
}

function comprimirImagem(file, maxLargura, qualidade) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const escala = Math.min(1, maxLargura / img.width)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * escala)
        canvas.height = Math.round(img.height * escala)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', qualidade))
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function gerarVersoesFoto(file) {
  const [thumb, full] = await Promise.all([
    comprimirImagem(file, 160, 0.55),
    comprimirImagem(file, 1280, 0.82)
  ])
  return { thumb, full }
}

// ============================================================
// HOOKS
// ============================================================

// Lista mestra simples (secoes, itens, marcas, locais): { nome, criadoEm }
function useMasterList(collectionName) {
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, collectionName), orderBy('nome', 'asc'))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const dados = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
      dados.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }))
      setLista(dados)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [collectionName])

  async function adicionar(nome) {
    const nomeLimpo = nome.trim()
    if (!nomeLimpo) return null
    const existente = lista.find((i) => i.nome.toLowerCase() === nomeLimpo.toLowerCase())
    if (existente) return existente.id
    const ref = await addDoc(collection(db, collectionName), {
      nome: nomeLimpo,
      criadoEm: serverTimestamp()
    })
    return ref.id
  }

  async function renomear(id, novoNome) {
    return updateDoc(doc(db, collectionName, id), { nome: novoNome.trim() })
  }

  async function remover(id) {
    return deleteDoc(doc(db, collectionName, id))
  }

  return { lista, loading, adicionar, renomear, remover }
}

const PRODUTOS_COLLECTION = 'produtos'

function useProdutos() {
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, PRODUTOS_COLLECTION), orderBy('itemNome', 'asc'))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setProdutos(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  function encontrar({ secaoId, itemId, marcaId }) {
    return produtos.find((p) => p.secaoId === secaoId && p.itemId === itemId && p.marcaId === marcaId)
  }

  // Mescla os pesos já conhecidos do produto com os pesos digitados nesse cadastro
  // — serve só pra sugerir depois na lista de compras.
  function mesclarPesosConhecidos(existentes, todasLinhas) {
    const mapa = new Map((existentes || []).map((v) => [`${v.peso}|${v.unidadePeso}`, v]))
    ;(todasLinhas || []).forEach((l) => {
      if (l.peso > 0) {
        const chave = `${l.peso}|${l.unidadePeso}`
        if (!mapa.has(chave)) mapa.set(chave, { peso: l.peso, unidadePeso: l.unidadePeso })
      }
    })
    return [...mapa.values()].sort((a, b) => a.peso - b.peso)
  }

  async function cadastrarProduto({ secaoId, secaoNome, itemId, itemNome, marcaId, marcaNome, todasLinhas }) {
    const existente = encontrar({ secaoId, itemId, marcaId })

    if (existente) {
      await updateDoc(doc(db, PRODUTOS_COLLECTION, existente.id), {
        pesosConhecidos: mesclarPesosConhecidos(existente.pesosConhecidos, todasLinhas),
        atualizadoEm: serverTimestamp()
      })
      return existente.id
    }

    const refDoc = await addDoc(collection(db, PRODUTOS_COLLECTION), {
      secaoId, secaoNome, itemId, itemNome, marcaId, marcaNome,
      pesosConhecidos: mesclarPesosConhecidos([], todasLinhas),
      compras: { desejado: false, linhas: [] },
      foto: null,
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp()
    })
    return refDoc.id
  }

  async function atualizarCompras(produtoId, compras) {
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produtoId), {
      compras,
      atualizadoEm: serverTimestamp()
    })
  }

  async function salvarFoto(produtoId, file) {
    const { thumb, full } = await gerarVersoesFoto(file)
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produtoId), {
      foto: { thumb, fullUrl: full },
      atualizadoEm: serverTimestamp()
    })
  }

  async function removerFoto(produtoId) {
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produtoId), {
      foto: null,
      atualizadoEm: serverTimestamp()
    })
  }

  async function removerProduto(produtoId) {
    return deleteDoc(doc(db, PRODUTOS_COLLECTION, produtoId))
  }

  async function atualizarCadastro(produtoId, dados) {
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produtoId), {
      ...dados,
      atualizadoEm: serverTimestamp()
    })
  }

  return { produtos, loading, cadastrarProduto, atualizarCompras, salvarFoto, removerFoto, removerProduto, atualizarCadastro }
}

// ============================================================
// COMPONENTES
// ============================================================

function SelectWithQuickAdd({ label, opcional, valor, onChange, opcoes, onCriar, onRenomear }) {
  const [modo, setModo] = useState('normal')
  const [texto, setTexto] = useState('')
  const [erro, setErro] = useState('')

  const itemAtual = opcoes.find((o) => o.id === valor)

  async function confirmarCriar() {
    const nome = texto.trim()
    if (!nome) return
    const existe = opcoes.some((o) => o.nome.toLowerCase() === nome.toLowerCase())
    if (existe) {
      setErro(`Já existe um(a) ${label.toLowerCase()} com esse nome`)
      return
    }
    const id = await onCriar(nome)
    if (id) onChange(id)
    setTexto('')
    setErro('')
    setModo('normal')
  }

  function iniciarRenomear() {
    if (!itemAtual) return
    setTexto(itemAtual.nome)
    setErro('')
    setModo('renomeando')
  }

  async function confirmarRenomear() {
    const nome = texto.trim()
    if (!nome || !itemAtual) { setModo('normal'); return }
    const existe = opcoes.some((o) => o.id !== itemAtual.id && o.nome.toLowerCase() === nome.toLowerCase())
    if (existe) {
      setErro(`Já existe um(a) ${label.toLowerCase()} com esse nome`)
      return
    }
    await onRenomear(itemAtual.id, nome)
    setTexto('')
    setErro('')
    setModo('normal')
  }

  function cancelar() {
    setModo('normal')
    setTexto('')
    setErro('')
  }

  return (
    <div className="mb-3">
      <label className="text-sm text-muted">{label}{opcional && <span className="text-muted/70"> (opcional)</span>}</label>
      {modo === 'normal' && (
        <div className="flex gap-2 mt-1">
          <select
            className="flex-1 px-3 py-2 rounded-xl border border-line bg-base text-ink"
            value={valor}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Selecione...</option>
            {opcoes.map((op) => (
              <option key={op.id} value={op.id}>{op.nome}</option>
            ))}
          </select>
          {onRenomear && itemAtual && (
            <button type="button" onClick={iniciarRenomear}
              className="w-11 h-11 shrink-0 rounded-xl bg-base border border-line text-muted flex items-center justify-center"
              aria-label={`Renomear ${label}`}>
              <Pencil size={17} />
            </button>
          )}
          <button type="button" onClick={() => setModo('criando')}
            className="w-11 h-11 shrink-0 rounded-xl bg-primary-light text-primary-dark flex items-center justify-center"
            aria-label={`Criar novo ${label}`}>
            <Plus size={20} />
          </button>
        </div>
      )}
      {modo !== 'normal' && (
        <div>
          <div className="flex gap-2 mt-1">
            <input autoFocus
              className={'flex-1 px-3 py-2 rounded-xl border bg-base text-ink ' + (erro ? 'border-danger' : 'border-primary')}
              value={texto} onChange={(e) => { setTexto(e.target.value); setErro('') }}
              placeholder={modo === 'criando' ? `Nome d${label.toLowerCase().startsWith('se') ? 'a' : 'o'} novo ${label.toLowerCase()}` : undefined}
              onKeyDown={(e) => e.key === 'Enter' && (modo === 'criando' ? confirmarCriar() : confirmarRenomear())} />
            <button onClick={modo === 'criando' ? confirmarCriar : confirmarRenomear}
              className="w-11 h-11 shrink-0 rounded-xl bg-primary text-white flex items-center justify-center">
              <Check size={18} />
            </button>
            <button onClick={cancelar}
              className="w-11 h-11 shrink-0 rounded-xl bg-line text-ink flex items-center justify-center">
              <X size={18} />
            </button>
          </div>
          {erro && <p className="text-xs text-danger mt-1.5">{erro}</p>}
        </div>
      )}
    </div>
  )
}

let chaveLinha = 1
const novaChaveLinha = () => String(chaveLinha++)
const linhaVazia = () => ({ key: novaChaveLinha(), peso: '', unidadePeso: 'kg' })

function EntradaForm({ secoesHook, itensHook, marcasHook, onSalvar, onAbrirEditarCategorias }) {
  const [secaoId, setSecaoId] = useState('')
  const [itemId, setItemId] = useState('')
  const [marcaId, setMarcaId] = useState('')
  const [linhas, setLinhas] = useState([linhaVazia()])
  const [salvando, setSalvando] = useState(false)
  const [sucesso, setSucesso] = useState(false)

  const valido = secaoId && itemId

  function atualizarLinha(key, campo, valor) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)))
  }

  async function salvar() {
    if (!valido || salvando) return
    setSalvando(true)
    try {
      const todasLinhas = linhas
        .map((l) => ({ peso: l.peso === '' ? 0 : Number(l.peso), unidadePeso: l.unidadePeso }))
        .filter((l) => l.peso > 0)
      await onSalvar({ secaoId, itemId, marcaId, todasLinhas })
      setSecaoId('')
      setItemId('')
      setMarcaId('')
      setLinhas([linhaVazia()])
      setSucesso(true)
      setTimeout(() => setSucesso(false), 1600)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="px-4 pb-2">
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-ink">Dados do produto</span>
          <button type="button" onClick={onAbrirEditarCategorias}
            className="flex items-center gap-1 text-xs font-medium text-muted" aria-label="Editar seção, item e marca">
            <Pencil size={12} /> Editar listas
          </button>
        </div>

        <SelectWithQuickAdd label="Seção" valor={secaoId} onChange={setSecaoId} opcoes={secoesHook.lista} onCriar={secoesHook.adicionar} />
        <SelectWithQuickAdd label="Item" valor={itemId} onChange={setItemId} opcoes={itensHook.lista} onCriar={itensHook.adicionar} />
        <SelectWithQuickAdd label="Marca" opcional valor={marcaId} onChange={setMarcaId} opcoes={marcasHook.lista} onCriar={marcasHook.adicionar} />

        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm text-muted">Pesos (opcional)</label>
          <button type="button" onClick={() => setLinhas((prev) => [...prev, linhaVazia()])}
            className="text-xs font-medium text-primary-dark bg-primary-light px-2.5 py-1 rounded-lg flex items-center gap-1">
            <Plus size={13} /> Adicionar peso
          </button>
        </div>

        {linhas.map((l) => (
          <div key={l.key} className="flex gap-2 mb-2 items-center">
            <input type="number" step="0.01"
              className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line bg-base"
              value={l.peso} onChange={(e) => atualizarLinha(l.key, 'peso', e.target.value)} placeholder="Peso" />
            <select className="w-16 px-1 py-2 rounded-xl border border-line bg-base text-sm"
              value={l.unidadePeso} onChange={(e) => atualizarLinha(l.key, 'unidadePeso', e.target.value)}>
              {UNIDADES_PESO.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            {linhas.length > 1 && (
              <button type="button" onClick={() => setLinhas((prev) => prev.filter((x) => x.key !== l.key))}
                className="text-danger p-1 shrink-0">
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
        <p className="text-[11px] text-muted mb-3">
          Os pesos aparecem depois como sugestão rápida na Lista de compras.
        </p>

        <button disabled={!valido || salvando} onClick={salvar}
          className="btn-primary w-full disabled:opacity-40">
          {salvando ? 'Salvando...' : sucesso ? 'Salvo ✓' : 'Cadastrar item'}
        </button>
      </div>
    </div>
  )
}

function EntradaModal({ onFechar, ...propsEntrada }) {
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-end justify-center" onClick={onFechar}>
      <div className="bg-base w-full max-w-md md:max-w-lg rounded-t-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mt-3" />
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <h2 className="text-lg font-display font-semibold text-ink">Cadastrar item</h2>
          <button onClick={onFechar} className="text-muted p-1" aria-label="Fechar">
            <X size={20} />
          </button>
        </div>
        <EntradaForm {...propsEntrada} />
      </div>
    </div>
  )
}

function FotoThumb({ produto, onEscolherArquivo, onAmpliar, carregando }) {
  const inputRef = useRef(null)

  if (produto.foto) {
    return (
      <button type="button" onClick={() => onAmpliar(produto)}
        className="w-9 h-9 rounded-lg overflow-hidden border border-line shrink-0"
        aria-label="Ampliar foto">
        <img src={produto.foto.thumb} alt={produto.itemNome} className="w-full h-full object-cover" />
      </button>
    )
  }

  return (
    <>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={carregando}
        className="w-9 h-9 rounded-lg border border-dashed border-line text-muted shrink-0 flex items-center justify-center bg-base"
        aria-label="Adicionar foto">
        {carregando ? <Loader2 size={14} className="animate-spin" /> : <Camera size={15} />}
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onEscolherArquivo(produto.id, f); e.target.value = '' }} />
    </>
  )
}

function FotoAmpliadaModal({ produto, onFechar, onTrocarFoto, onRemoverFoto, carregando }) {
  const inputRef = useRef(null)
  if (!produto || !produto.foto) return null

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6" onClick={onFechar}>
      <div className="max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <img src={produto.foto.fullUrl || produto.foto.thumb} alt={produto.itemNome} className="w-full rounded-2xl" />
        <p className="text-white text-center text-sm mt-3">{produto.itemNome} — {produto.marcaNome}</p>

        {(onTrocarFoto || onRemoverFoto) && (
          <div className="flex items-center justify-center gap-3 mt-4">
            {onTrocarFoto && (
              <button onClick={() => inputRef.current?.click()} disabled={carregando}
                className="flex items-center gap-1.5 text-sm text-white/90 bg-white/10 px-3 py-1.5 rounded-lg disabled:opacity-50">
                {carregando ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />} Trocar foto
              </button>
            )}
            {onRemoverFoto && (
              <button onClick={() => onRemoverFoto(produto.id)} disabled={carregando}
                className="flex items-center gap-1.5 text-sm text-white/90 bg-white/10 px-3 py-1.5 rounded-lg disabled:opacity-50">
                <Trash2 size={14} /> Remover
              </button>
            )}
          </div>
        )}

        <button onClick={onFechar} className="mx-auto mt-4 flex items-center gap-1 text-white/70 text-sm">
          <X size={14} /> Fechar
        </button>

        {onTrocarFoto && (
          <input ref={inputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onTrocarFoto(produto.id, f); e.target.value = '' }} />
        )}
      </div>
    </div>
  )
}

function EditarProdutoModal({ produto, secoes, itens, marcas, criarSecao, criarItem, criarMarca, renomearSecao, renomearItem, renomearMarca, onConfirmar, onFechar }) {
  const [secaoId, setSecaoId] = useState(produto.secaoId || '')
  const [itemId, setItemId] = useState(produto.itemId || '')
  const [marcaId, setMarcaId] = useState(produto.marcaId === 'sem-marca' ? '' : (produto.marcaId || ''))
  const [pesos, setPesos] = useState(produto.pesosConhecidos || [])
  const [novoPeso, setNovoPeso] = useState('')
  const [novaUnidadePeso, setNovaUnidadePeso] = useState('kg')
  const [salvando, setSalvando] = useState(false)

  function adicionarPeso() {
    const valor = Number(novoPeso)
    if (!valor || valor <= 0) return
    const jaExiste = pesos.some((p) => p.peso === valor && p.unidadePeso === novaUnidadePeso)
    if (!jaExiste) {
      setPesos((prev) => [...prev, { peso: valor, unidadePeso: novaUnidadePeso }].sort((a, b) => a.peso - b.peso))
    }
    setNovoPeso('')
  }

  function removerPeso(peso, unidadePeso) {
    setPesos((prev) => prev.filter((p) => !(p.peso === peso && p.unidadePeso === unidadePeso)))
  }

  async function confirmar() {
    if (!secaoId || !itemId || salvando) return
    setSalvando(true)
    try {
      await onConfirmar({ secaoId, itemId, marcaId, pesosConhecidos: pesos })
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-1">Editar cadastro</h2>
        <p className="text-sm text-muted mb-4">{produto.itemNome} — {produto.marcaNome}</p>

        <SelectWithQuickAdd label="Seção" valor={secaoId} onChange={setSecaoId} opcoes={secoes} onCriar={criarSecao} onRenomear={renomearSecao} />
        <SelectWithQuickAdd label="Item" valor={itemId} onChange={setItemId} opcoes={itens} onCriar={criarItem} onRenomear={renomearItem} />
        <SelectWithQuickAdd label="Marca" opcional valor={marcaId} onChange={setMarcaId} opcoes={marcas} onCriar={criarMarca} onRenomear={renomearMarca} />

        <div className="mb-4">
          <label className="text-sm text-muted block mb-1">Pesos conhecidos</label>
          <p className="text-[11px] text-muted mb-2">Aparecem como sugestão rápida na Lista de compras.</p>
          {pesos.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {pesos.map((p) => (
                <span key={`${p.peso}-${p.unidadePeso}`}
                  className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-accent-light text-accent-dark">
                  {rotuloVariante(p)}
                  <button type="button" onClick={() => removerPeso(p.peso, p.unidadePeso)} className="text-accent-dark/70">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="number" step="0.01" value={novoPeso} onChange={(e) => setNovoPeso(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && adicionarPeso()}
              placeholder="Peso" className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line bg-base" />
            <select value={novaUnidadePeso} onChange={(e) => setNovaUnidadePeso(e.target.value)}
              className="w-16 px-1 py-2 rounded-xl border border-line bg-base text-sm">
              {UNIDADES_PESO.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <button type="button" onClick={adicionarPeso}
              className="w-11 h-11 shrink-0 rounded-xl bg-primary-light text-primary-dark flex items-center justify-center">
              <Plus size={20} />
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onFechar}>Cancelar</button>
          <button disabled={!secaoId || !itemId || salvando} onClick={confirmar} className="btn-primary flex-1 disabled:opacity-40">
            {salvando ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmarExclusaoModal({ produto, onConfirmar, onFechar }) {
  const [excluindo, setExcluindo] = useState(false)
  if (!produto) return null

  async function confirmar() {
    setExcluindo(true)
    try { await onConfirmar() } finally { setExcluindo(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-1 text-danger">Excluir produto</h2>
        <p className="text-sm text-muted mb-4">
          {produto.itemNome} — {produto.marcaNome}. Isso remove o produto do catálogo. Não tem como desfazer.
        </p>
        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onFechar}>Cancelar</button>
          <button disabled={excluindo} onClick={confirmar}
            className="flex-1 rounded-xl px-4 py-2.5 font-medium text-white bg-danger disabled:opacity-50">
            {excluindo ? 'Excluindo...' : 'Excluir'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EstoquePanel({ produtos: produtosBrutos, onFoto, onRemoverFoto, secoes, itens, marcas, criarSecao, criarItem, criarMarca, renomearSecao, renomearItem, renomearMarca, onEditarProduto, onExcluirProduto, onSalvarEntrada, onAbrirEditarCategorias, onAtualizarCompras, compradores, criarComprador, listas, criarLista }) {
  const produtos = useMemo(() => produtosBrutos.map((p) => ({
    ...p,
    itemNome: nomeAtual(itens, p.itemId, p.itemNome),
    marcaNome: nomeAtual(marcas, p.marcaId, p.marcaNome),
    secaoNome: nomeAtual(secoes, p.secaoId, p.secaoNome)
  })), [produtosBrutos, itens, marcas, secoes])

  const [carregandoId, setCarregandoId] = useState(null)
  const [fotoAmpliadaId, setFotoAmpliadaId] = useState(null)
  const [editandoProduto, setEditandoProduto] = useState(null)
  const [excluindoProduto, setExcluindoProduto] = useState(null)
  const [mostrandoEntrada, setMostrandoEntrada] = useState(false)
  const [adicionandoCompra, setAdicionandoCompra] = useState(null)

  const produtoAmpliado = produtos.find((p) => p.id === fotoAmpliadaId) || null

  async function handleAdicionarACompras(produto) {
    const compras = comprasNormalizadas(produto.compras)
    if (!compras.desejado) {
      await onAtualizarCompras(produto.id, { ...compras, desejado: true })
    }
    setAdicionandoCompra({ ...produto, compras: { ...compras, desejado: true } })
  }

  async function handleEditarProduto(produtoId, dados) {
    const secao = secoes.find((s) => s.id === dados.secaoId)
    const item = itens.find((i) => i.id === dados.itemId)
    const marca = marcas.find((m) => m.id === dados.marcaId)
    await onEditarProduto(produtoId, {
      secaoId: dados.secaoId, secaoNome: secao?.nome || '',
      itemId: dados.itemId, itemNome: item?.nome || '',
      marcaId: dados.marcaId || 'sem-marca', marcaNome: marca?.nome || 'Sem marca',
      pesosConhecidos: dados.pesosConhecidos
    })
  }

  async function handleEscolherArquivo(produtoId, file) {
    setCarregandoId(produtoId)
    try { await onFoto(produtoId, file) } finally { setCarregandoId(null) }
  }

  async function handleRemoverFoto(produtoId) {
    setCarregandoId(produtoId)
    try {
      await onRemoverFoto(produtoId)
      setFotoAmpliadaId(null)
    } finally {
      setCarregandoId(null)
    }
  }

  return (
    <div className="px-4 pt-4 pb-28">
      <div className="flex items-center mb-4">
        <h2 className="text-lg font-display font-semibold text-ink md:hidden">Produtos cadastrados</h2>
        <button onClick={() => setMostrandoEntrada(true)}
          className="ml-auto flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-primary text-white">
          <Plus size={16} /> Entrada
        </button>
      </div>
      {produtos.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-ink font-medium mb-1">Nenhum produto cadastrado ainda</p>
          <p className="text-sm text-muted">Toque em "Entrada" pra cadastrar o primeiro item.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3 md:items-start">
        {produtos.map((p) => (
          <div key={p.id} className="card p-2.5">
            <div className="flex items-center gap-2.5">
              <FotoThumb produto={p} onEscolherArquivo={handleEscolherArquivo} onAmpliar={(produto) => setFotoAmpliadaId(produto.id)} carregando={carregandoId === p.id} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="font-medium text-ink text-[13.5px] truncate">{p.itemNome}</span>
                  <span className="text-muted text-xs truncate">— {p.marcaNome}</span>
                </div>
                <span className="tag-feira text-primary-dark mt-1">{p.secaoNome}</span>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => setEditandoProduto(p)}
                  title="Editar cadastro" aria-label="Editar cadastro"
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-base border border-line text-muted">
                  <Pencil size={12} />
                </button>
                <button onClick={() => handleAdicionarACompras(p)}
                  title="Adicionar à lista de compras" aria-label="Adicionar à lista de compras"
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent-light text-accent-dark">
                  <ShoppingCart size={12} />
                </button>
                <button onClick={() => setExcluindoProduto(p)}
                  title="Excluir produto" aria-label="Excluir produto"
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-danger-light text-danger">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <FotoAmpliadaModal produto={produtoAmpliado} onFechar={() => setFotoAmpliadaId(null)}
        onTrocarFoto={handleEscolherArquivo} onRemoverFoto={handleRemoverFoto}
        carregando={carregandoId === fotoAmpliadaId} />

      {editandoProduto && (
        <EditarProdutoModal
          produto={editandoProduto}
          secoes={secoes} itens={itens} marcas={marcas}
          criarSecao={criarSecao} criarItem={criarItem} criarMarca={criarMarca}
          renomearSecao={renomearSecao} renomearItem={renomearItem} renomearMarca={renomearMarca}
          onFechar={() => setEditandoProduto(null)}
          onConfirmar={async (dados) => {
            await handleEditarProduto(editandoProduto.id, dados)
            setEditandoProduto(null)
          }} />
      )}

      {adicionandoCompra && (
        <AdicionarACompraModal
          produto={adicionandoCompra}
          onAtualizar={onAtualizarCompras}
          compradores={compradores} criarComprador={criarComprador}
          listas={listas} criarLista={criarLista}
          onFechar={() => setAdicionandoCompra(null)} />
      )}

      {excluindoProduto && (
        <ConfirmarExclusaoModal
          produto={excluindoProduto}
          onFechar={() => setExcluindoProduto(null)}
          onConfirmar={async () => {
            await onExcluirProduto(excluindoProduto.id)
            setExcluindoProduto(null)
          }} />
      )}

      {mostrandoEntrada && (
        <EntradaModal
          onFechar={() => setMostrandoEntrada(false)}
          secoesHook={{ lista: secoes, adicionar: criarSecao }}
          itensHook={{ lista: itens, adicionar: criarItem }}
          marcasHook={{ lista: marcas, adicionar: criarMarca }}
          onAbrirEditarCategorias={onAbrirEditarCategorias}
          onSalvar={onSalvarEntrada} />
      )}
    </div>
  )
}

let chaveCompra = 1
const novaChaveCompra = () => String(chaveCompra++)

function LinhaProduto({ produto, onAtualizar, onAmpliarFoto, compradores, criarComprador, listas, criarLista, iniciarAberto }) {
  const compras = comprasNormalizadas(produto.compras)
  const [linhas, setLinhas] = useState(() =>
    compras.linhas.length > 0
      ? compras.linhas.map((l) => ({ key: novaChaveCompra(), peso: l.peso || '', unidadePeso: l.unidadePeso || 'kg', unidades: l.unidades || '' }))
      : [{ key: novaChaveCompra(), peso: '', unidadePeso: 'kg', unidades: '' }]
  )
  const [compradorId, setCompradorId] = useState(() => compradores.find((c) => c.nome === compras.compradorNome)?.id || '')
  const [listaId, setListaId] = useState(() => listas.find((l) => l.nome === compras.listaNome)?.id || '')
  const [aberto, setAberto] = useState(!!iniciarAberto)
  const variantes = produto.pesosConhecidos || []

  function salvar(patch) {
    const linhasFonte = patch.linhas || linhas
    onAtualizar(produto.id, {
      desejado: patch.desejado ?? compras.desejado,
      compradorId: patch.compradorId ?? compras.compradorId,
      compradorNome: patch.compradorNome ?? compras.compradorNome,
      listaId: patch.listaId ?? compras.listaId,
      listaNome: patch.listaNome ?? compras.listaNome,
      comprado: patch.comprado ?? compras.comprado,
      linhas: linhasFonte
        .map((l) => ({
          peso: l.peso === '' ? 0 : Number(l.peso),
          unidadePeso: l.unidadePeso,
          unidades: l.unidades === '' ? 0 : Number(l.unidades)
        }))
        .filter((l) => l.peso > 0 || l.unidades > 0)
    })
  }

  function alternarDesejado() {
    const novoDesejado = !compras.desejado
    salvar({ desejado: novoDesejado, comprado: novoDesejado ? false : compras.comprado })
    setAberto(novoDesejado)
  }

  function atualizarLinha(key, campo, valor) {
    setLinhas((prev) => {
      const novas = prev.map((l) => (l.key === key ? { ...l, [campo]: valor } : l))
      if (campo === 'unidadePeso') salvar({ linhas: novas })
      return novas
    })
  }

  function removerLinha(key) {
    setLinhas((prev) => {
      const novas = prev.length > 1 ? prev.filter((l) => l.key !== key) : prev
      salvar({ linhas: novas })
      return novas
    })
  }

  function selecionarVariante(v) {
    setLinhas((prev) => {
      const jaExiste = prev.some((l) => l.peso !== '' && Number(l.peso) === v.peso && l.unidadePeso === v.unidadePeso)
      if (jaExiste) return prev
      const idxVazio = prev.findIndex((l) => l.peso === '' && l.unidades === '')
      const novas = idxVazio >= 0
        ? prev.map((l, i) => (i === idxVazio ? { ...l, peso: String(v.peso), unidadePeso: v.unidadePeso } : l))
        : [...prev, { key: novaChaveCompra(), peso: String(v.peso), unidadePeso: v.unidadePeso, unidades: '' }]
      salvar({ linhas: novas })
      return novas
    })
  }

  function escolherComprador(id) {
    setCompradorId(id)
    const comprador = compradores.find((c) => c.id === id)
    salvar({ compradorId: id, compradorNome: comprador?.nome || '' })
  }

  function escolherLista(id) {
    setListaId(id)
    const lista = listas.find((l) => l.id === id)
    salvar({ listaId: id, listaNome: lista?.nome || '' })
  }

  const resumoQuantidade = linhasQuantidadeFormatadas(compras.linhas).join(' · ')

  return (
    <div className={'card p-2.5 ' + (compras.desejado ? 'ring-1 ring-primary border-primary' : '')}>
      <div className="flex items-center gap-2.5">
        <input type="checkbox" className="w-4.5 h-4.5 rounded accent-primary shrink-0"
          checked={compras.desejado} onChange={alternarDesejado} />
        {produto.foto ? (
          <button type="button" onClick={onAmpliarFoto}
            className="w-9 h-9 rounded-lg overflow-hidden shrink-0 border border-line" aria-label="Ampliar foto">
            <img src={produto.foto.thumb} alt={produto.itemNome} className="w-full h-full object-cover" />
          </button>
        ) : (
          <div className="w-9 h-9 rounded-lg bg-line shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-medium text-ink text-[13.5px] truncate">{produto.itemNome}</span>
            <span className="text-muted text-xs truncate">— {produto.marcaNome}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            <span className="tag-feira text-accent-dark">{produto.secaoNome}</span>
            {compras.listaNome && <span className="text-[10px] text-primary-dark font-medium">📋 {compras.listaNome}</span>}
            {compras.compradorNome && <span className="text-[10px] text-muted">👤 {compras.compradorNome}</span>}
          </div>
        </div>
      </div>

      {compras.desejado && !aberto && (
        <div className="mt-2 pl-[42px] flex items-center justify-between gap-2">
          <span className="text-xs text-muted truncate">{resumoQuantidade || 'Sem quantidade definida'}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => salvar({ comprado: true, desejado: false })}
              className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-primary text-white">
              <Check size={11} /> Comprei
            </button>
            <button type="button" onClick={() => setAberto(true)} className="text-muted p-1" aria-label="Editar quantidade">
              <Pencil size={13} />
            </button>
          </div>
        </div>
      )}

      {compras.desejado && aberto && (
        <div className="mt-2.5 pl-[42px]">
          {variantes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {variantes.map((v) => (
                <button key={`${v.peso}-${v.unidadePeso}`} type="button" onClick={() => selecionarVariante(v)}
                  className="text-xs font-medium px-2.5 py-1 rounded-lg bg-accent-light text-accent-dark">
                  {rotuloVariante(v)}
                </button>
              ))}
            </div>
          )}
          {linhas.map((l) => (
            <div key={l.key} className="flex gap-2 mb-2 items-center">
              <input type="number" step="0.01"
                className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-line bg-base text-sm"
                value={l.peso}
                onChange={(e) => atualizarLinha(l.key, 'peso', e.target.value)}
                onBlur={() => salvar({})}
                placeholder="Peso" />
              <select className="w-14 px-1 py-1.5 rounded-lg border border-line bg-base text-sm"
                value={l.unidadePeso}
                onChange={(e) => atualizarLinha(l.key, 'unidadePeso', e.target.value)}>
                {UNIDADES_PESO.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <input type="number"
                className="w-16 px-2 py-1.5 rounded-lg border border-line bg-base text-sm"
                value={l.unidades}
                onChange={(e) => atualizarLinha(l.key, 'unidades', e.target.value)}
                onBlur={() => salvar({})}
                placeholder="Un" />
              {linhas.length > 1 && (
                <button type="button" onClick={() => removerLinha(l.key)} className="text-danger p-1 shrink-0">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setLinhas((prev) => [...prev, { key: novaChaveCompra(), peso: '', unidadePeso: 'kg', unidades: '' }])}
            className="text-xs font-medium text-primary-dark bg-primary-light px-2.5 py-1 rounded-lg flex items-center gap-1 mb-2">
            <Plus size={12} /> Adicionar peso
          </button>

          <SelectWithQuickAdd label="Lista" opcional valor={listaId} onChange={escolherLista} opcoes={listas} onCriar={criarLista} />
          <SelectWithQuickAdd label="Comprador" opcional valor={compradorId} onChange={escolherComprador} opcoes={compradores} onCriar={criarComprador} />

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => salvar({ comprado: true, desejado: false })}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-white">
              <Check size={13} /> Comprei
            </button>
            <button type="button" onClick={() => setAberto(false)}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-ink text-white">
              <Check size={13} /> Pronto
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AdicionarACompraModal({ produto, onAtualizar, compradores, criarComprador, listas, criarLista, onFechar }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Adicionar à lista de compras</h2>
          <button onClick={onFechar} className="text-muted p-1" aria-label="Fechar"><X size={20} /></button>
        </div>
        <LinhaProduto produto={produto} onAtualizar={onAtualizar}
          compradores={compradores} criarComprador={criarComprador}
          listas={listas} criarLista={criarLista}
          onAmpliarFoto={() => {}} iniciarAberto />
      </div>
    </div>
  )
}

function gerarTextoWhatsApp(selecionados) {
  const linhas = selecionados.map(({ produto, compras }) => {
    const dets = linhasQuantidadeFormatadas(compras.linhas)
    const detalheTexto = dets.length > 0 ? `\n   ${dets.join('\n   ')}` : ''
    return `▫️ ${produto.itemNome} — ${produto.marcaNome}${detalheTexto}`
  })
  return `🛒 *Lista de compras — Mercado Inteligente*\n${formatarData(hojeISO())}\n\n${linhas.join('\n\n')}`
}

function gerarPdfCompras(selecionados) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margem = 12

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text('Lista de compras — Mercado Inteligente', margem, 14)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(120)
  doc.text(formatarData(hojeISO()), margem, 19)
  doc.setTextColor(0)

  autoTable(doc, {
    startY: 23,
    head: [['', 'Produto', 'Quantidade']],
    body: selecionados.map(({ produto, compras }) => [
      '',
      `${produto.itemNome} — ${produto.marcaNome}  ·  ${produto.secaoNome}`,
      linhasQuantidadeFormatadas(compras.linhas).join('\n') || '—'
    ]),
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2, valign: 'middle', minCellHeight: 7 },
    headStyles: { fillColor: [47, 129, 69], textColor: 255, fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 7 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 34 }
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 0) return
      const { x, y, width, height } = data.cell
      const tam = 3.2
      doc.setDrawColor(140)
      doc.rect(x + width / 2 - tam / 2, y + height / 2 - tam / 2, tam, tam)
    }
  })

  return doc
}

// Tenta compartilhar o PDF direto (funciona em navegadores/celulares com suporte
// ao compartilhamento nativo de arquivos). Se não suportar, baixa o PDF e abre
// o WhatsApp com o texto pronto, pra anexar manualmente.
async function compartilharOuBaixarPdf(doc, nomeArquivo, textoWhats) {
  if (navigator.canShare) {
    try {
      const blob = doc.output('blob')
      const arquivo = new File([blob], nomeArquivo, { type: 'application/pdf' })
      if (navigator.canShare({ files: [arquivo] })) {
        await navigator.share({ files: [arquivo], title: 'Lista de compras — Mercado Inteligente', text: textoWhats })
        return
      }
    } catch (err) {
      // cancelado pelo usuário ou não suportado — segue pro fallback abaixo
    }
  }
  doc.save(nomeArquivo)
  window.open('https://wa.me/?text=' + encodeURIComponent(textoWhats), '_blank', 'noopener,noreferrer')
}

function ListaComprasPanel({ produtos: produtosBrutos, onAtualizar, secoes, itens, marcas, compradoresHook, listasHook }) {
  const compradores = compradoresHook.lista
  const criarComprador = compradoresHook.adicionar
  const listas = listasHook.lista
  const criarLista = listasHook.adicionar
  const [filtro, setFiltro] = useState('todos')
  const [filtroSecao, setFiltroSecao] = useState('todas')
  const [filtroComprador, setFiltroComprador] = useState('todos')
  const [filtroLista, setFiltroLista] = useState('todas')
  const [fotoAmpliadaId, setFotoAmpliadaId] = useState(null)
  const [gerenciandoCompradores, setGerenciandoCompradores] = useState(false)
  const [gerenciandoListas, setGerenciandoListas] = useState(false)

  // Sempre resolve o nome atual da seção/item/marca pelo id, em vez do texto
  // que ficou salvo na hora da entrada — assim renomear reflete aqui.
  const produtos = useMemo(() => produtosBrutos.map((p) => ({
    ...p,
    itemNome: nomeAtual(itens, p.itemId, p.itemNome),
    marcaNome: nomeAtual(marcas, p.marcaId, p.marcaNome),
    secaoNome: nomeAtual(secoes, p.secaoId, p.secaoNome)
  })), [produtosBrutos, itens, marcas, secoes])

  const produtoAmpliado = produtos.find((p) => p.id === fotoAmpliadaId) || null

  const secoesDisponiveis = useMemo(() => {
    const nomes = new Set(produtos.map((p) => p.secaoNome).filter(Boolean))
    return [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
  }, [produtos])

  function combinaComprador(compras) {
    if (filtroComprador === 'todos') return true
    if (filtroComprador === 'sem') return !compras.compradorNome
    return compras.compradorNome === filtroComprador
  }

  function combinaLista(compras) {
    if (filtroLista === 'todas') return true
    if (filtroLista === 'sem') return !compras.listaNome
    return compras.listaNome === filtroLista
  }

  const visiveis = produtos
    .filter((p) => (filtro === 'selecionados' ? comprasNormalizadas(p.compras).desejado : true))
    .filter((p) => (filtroSecao === 'todas' ? true : p.secaoNome === filtroSecao))
    .filter((p) => combinaComprador(comprasNormalizadas(p.compras)))
    .filter((p) => (filtro === 'selecionados' ? combinaLista(comprasNormalizadas(p.compras)) : true))

  // Reflete exatamente o que os filtros atuais mostrariam de itens marcados —
  // é o que vai pro Imprimir/WhatsApp, então filtrar por Lista manda só aquela lista.
  const selecionados = produtos
    .map((p) => ({ produto: p, compras: comprasNormalizadas(p.compras) }))
    .filter((x) => x.compras.desejado)
    .filter((x) => filtroSecao === 'todas' || x.produto.secaoNome === filtroSecao)
    .filter((x) => combinaComprador(x.compras))
    .filter((x) => combinaLista(x.compras))
  const totalSel = selecionados.length

  function handleImprimir() {
    const doc = gerarPdfCompras(selecionados)
    doc.autoPrint()
    window.open(doc.output('bloburl'), '_blank')
  }

  async function handleWhatsApp() {
    const doc = gerarPdfCompras(selecionados)
    await compartilharOuBaixarPdf(doc, 'lista-de-compras.pdf', gerarTextoWhatsApp(selecionados))
  }

  async function handleEsvaziarCarrinho() {
    await Promise.all(
      selecionados.map(({ produto }) =>
        onAtualizar(produto.id, { desejado: false, comprado: false, compradorId: '', compradorNome: '', listaId: '', listaNome: '', linhas: [] })
      )
    )
  }

  return (
    <div className="px-4 pt-4 pb-28">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h2 className="text-lg font-display font-semibold text-ink md:hidden">Lista de compras</h2>
        {totalSel > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs bg-primary-light text-primary-dark px-2 py-1 rounded-full font-medium whitespace-nowrap">
              {totalSel} selecionado{totalSel > 1 ? 's' : ''}
            </span>
            <button onClick={handleEsvaziarCarrinho}
              className="text-xs font-medium text-danger px-2 py-1 rounded-lg bg-danger-light whitespace-nowrap">
              Esvaziar lista
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        <button onClick={() => setFiltro('todos')}
          className={'chip ' + (filtro === 'todos' ? 'bg-primary text-white border-primary' : 'bg-surface text-muted border-line')}>
          Todos os produtos
        </button>
        <button onClick={() => setFiltro('selecionados')}
          className={'chip ' + (filtro === 'selecionados' ? 'bg-primary text-white border-primary' : 'bg-surface text-muted border-line')}>
          Selecionados
        </button>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        {secoesDisponiveis.length > 0 && (
          <select value={filtroSecao} onChange={(e) => setFiltroSecao(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-line bg-surface text-sm text-ink">
            <option value="todas">Todas as seções</option>
            {secoesDisponiveis.map((nome) => (
              <option key={nome} value={nome}>{nome}</option>
            ))}
          </select>
        )}

        {listas.length > 0 ? (
          <div className="flex gap-2">
            <select value={filtroLista} onChange={(e) => setFiltroLista(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line bg-surface text-sm text-ink">
              <option value="todas">Todas as listas</option>
              <option value="sem">Sem lista</option>
              {listas.map((l) => (
                <option key={l.id} value={l.nome}>{l.nome}</option>
              ))}
            </select>
            <button onClick={() => setGerenciandoListas(true)}
              className="w-10 h-10 shrink-0 rounded-xl bg-primary-light text-primary-dark flex items-center justify-center" aria-label="Adicionar lista">
              <Plus size={18} />
            </button>
            <button onClick={() => setGerenciandoListas(true)}
              className="w-10 h-10 shrink-0 rounded-xl bg-base border border-line text-muted flex items-center justify-center" aria-label="Editar listas">
              <Pencil size={16} />
            </button>
          </div>
        ) : (
          <button onClick={() => setGerenciandoListas(true)}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-primary-light text-primary-dark self-start">
            <Plus size={16} /> Cadastrar lista
          </button>
        )}
        {filtroLista !== 'todas' && filtro !== 'selecionados' && (
          <p className="text-[11px] text-muted -mt-1">O filtro de lista só se aplica na aba "Selecionados".</p>
        )}

        {compradores.length > 0 ? (
          <div className="flex gap-2">
            <select value={filtroComprador} onChange={(e) => setFiltroComprador(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line bg-surface text-sm text-ink">
              <option value="todos">Todos os compradores</option>
              <option value="sem">Sem comprador</option>
              {compradores.map((c) => (
                <option key={c.id} value={c.nome}>{c.nome}</option>
              ))}
            </select>
            <button onClick={() => setGerenciandoCompradores(true)}
              className="w-10 h-10 shrink-0 rounded-xl bg-primary-light text-primary-dark flex items-center justify-center" aria-label="Adicionar comprador">
              <Plus size={18} />
            </button>
            <button onClick={() => setGerenciandoCompradores(true)}
              className="w-10 h-10 shrink-0 rounded-xl bg-base border border-line text-muted flex items-center justify-center" aria-label="Editar compradores">
              <Pencil size={16} />
            </button>
          </div>
        ) : (
          <button onClick={() => setGerenciandoCompradores(true)}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-primary-light text-primary-dark self-start">
            <Plus size={16} /> Cadastrar comprador
          </button>
        )}
      </div>

      {totalSel > 0 && (
        <div className="mb-4">
          <div className="flex gap-2">
            <button onClick={handleImprimir}
              className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-ink text-white">
              <Printer size={15} /> Imprimir
            </button>
            <button onClick={handleWhatsApp}
              className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-primary text-white">
              <Share2 size={15} /> Enviar no WhatsApp
            </button>
          </div>
          <p className="text-[11px] text-muted mt-1.5 text-center">
            {filtroLista !== 'todas' ? `Só a lista "${filtroLista === 'sem' ? 'sem lista' : filtroLista}" será impressa/enviada. ` : ''}
            No celular, "Enviar no WhatsApp" já anexa o PDF direto; se o aparelho não suportar, ele baixa o PDF e abre o WhatsApp pra anexar na conversa.
          </p>
        </div>
      )}

      {visiveis.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-ink font-medium mb-1">
            {filtroSecao !== 'todas' || filtroComprador !== 'todos' || filtroLista !== 'todas' ? 'Nada com esse filtro' : filtro === 'selecionados' ? 'Nada selecionado ainda' : 'Nenhum produto cadastrado ainda'}
          </p>
          <p className="text-sm text-muted">
            {filtroSecao !== 'todas' || filtroComprador !== 'todos' || filtroLista !== 'todas' ? 'Tenta ajustar os filtros pra ver os outros produtos.' : filtro === 'selecionados' ? 'Marque a caixinha de um produto pra colocar na lista.' : 'Produtos aparecem aqui automaticamente após a primeira entrada.'}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3 md:items-start">
        {visiveis.map((p) => (
          <LinhaProduto key={p.id} produto={p} onAtualizar={onAtualizar}
            onAmpliarFoto={() => setFotoAmpliadaId(p.id)}
            compradores={compradores} criarComprador={criarComprador}
            listas={listas} criarLista={criarLista} />
        ))}
      </div>

      <FotoAmpliadaModal produto={produtoAmpliado} onFechar={() => setFotoAmpliadaId(null)} />

      {gerenciandoCompradores && (
        <EditarCompradoresModal compradoresHook={compradoresHook} onFechar={() => setGerenciandoCompradores(false)} />
      )}
      {gerenciandoListas && (
        <EditarListasModal listasHook={listasHook} onFechar={() => setGerenciandoListas(false)} />
      )}
    </div>
  )
}

function ListaEditavelInline({ titulo, placeholder, lista, adicionar, renomear, remover }) {
  const [novoNome, setNovoNome] = useState('')
  const [erro, setErro] = useState('')
  const [editandoId, setEditandoId] = useState(null)
  const [nomeEdicao, setNomeEdicao] = useState('')

  async function handleAdicionar() {
    const nome = novoNome.trim()
    if (!nome) return
    const existe = lista.some((i) => i.nome.toLowerCase() === nome.toLowerCase())
    if (existe) {
      setErro(`Já existe "${nome}" nessa lista`)
      return
    }
    await adicionar(nome)
    setNovoNome('')
    setErro('')
  }

  function iniciarEdicao(item) {
    setEditandoId(item.id)
    setNomeEdicao(item.nome)
  }

  async function confirmarEdicao() {
    if (nomeEdicao.trim()) await renomear(editandoId, nomeEdicao)
    setEditandoId(null)
  }

  return (
    <div className="mb-4">
      <h3 className="font-medium text-ink mb-2 text-sm">{titulo} <span className="text-muted font-normal">({lista.length})</span></h3>
      <div className="flex gap-2">
        <input className="flex-1 px-3 py-2 rounded-xl border bg-base text-sm"
          style={{ borderColor: erro ? '#D6472A' : undefined }}
          value={novoNome} onChange={(e) => { setNovoNome(e.target.value); setErro('') }}
          placeholder={placeholder}
          onKeyDown={(e) => e.key === 'Enter' && handleAdicionar()} />
        <button onClick={handleAdicionar} className="btn-primary px-3 text-sm">Add</button>
      </div>
      {erro && <p className="text-xs text-danger mt-1.5">{erro}</p>}
      <div className="flex flex-col gap-1 mt-2">
        {lista.map((item) => (
          <div key={item.id} className="flex items-center gap-2 py-1 border-b border-line last:border-0">
            {editandoId === item.id ? (
              <>
                <input autoFocus className="flex-1 px-2 py-1 rounded-lg border border-primary bg-base text-sm"
                  value={nomeEdicao} onChange={(e) => setNomeEdicao(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && confirmarEdicao()} />
                <button onClick={confirmarEdicao} className="text-primary-dark text-sm font-medium px-2">Salvar</button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-ink">{item.nome}</span>
                <button onClick={() => iniciarEdicao(item)} className="text-muted p-1"><Pencil size={14} /></button>
                <button onClick={() => remover(item.id)} className="text-danger p-1"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
        {lista.length === 0 && <p className="text-xs text-muted py-1">Nenhuma ainda.</p>}
      </div>
    </div>
  )
}

function EditarCategoriasModal({ secoesHook, itensHook, marcasHook, onFechar }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-3">Editar seção, item e marca</h2>
        <ListaEditavelInline titulo="Seção" placeholder="nome da seção" lista={secoesHook.lista} adicionar={secoesHook.adicionar} renomear={secoesHook.renomear} remover={secoesHook.remover} />
        <ListaEditavelInline titulo="Item" placeholder="nome do item" lista={itensHook.lista} adicionar={itensHook.adicionar} renomear={itensHook.renomear} remover={itensHook.remover} />
        <ListaEditavelInline titulo="Marca" placeholder="nome da marca" lista={marcasHook.lista} adicionar={marcasHook.adicionar} renomear={marcasHook.renomear} remover={marcasHook.remover} />
        <button onClick={onFechar} className="btn-secondary w-full">Fechar</button>
      </div>
    </div>
  )
}

function EditarCompradoresModal({ compradoresHook, onFechar }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-3">Editar compradores</h2>
        <ListaEditavelInline titulo="Comprador" placeholder="nome do comprador" lista={compradoresHook.lista} adicionar={compradoresHook.adicionar} renomear={compradoresHook.renomear} remover={compradoresHook.remover} />
        <button onClick={onFechar} className="btn-secondary w-full">Fechar</button>
      </div>
    </div>
  )
}

function EditarListasModal({ listasHook, onFechar }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-3">Editar listas</h2>
        <ListaEditavelInline titulo="Lista" placeholder="nome da lista (ex: Frutas, Pet)" lista={listasHook.lista} adicionar={listasHook.adicionar} renomear={listasHook.renomear} remover={listasHook.remover} />
        <button onClick={onFechar} className="btn-secondary w-full">Fechar</button>
      </div>
    </div>
  )
}

const ABAS_NAV = [
  { id: 'estoque', label: 'Produtos', Icon: Package },
  { id: 'compras', label: 'Compras', Icon: ShoppingCart }
]

function BottomNav({ ativa, onChange }) {
  return (
    <>
      {/* Mobile: barra inferior fixa */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-surface border-t border-line flex max-w-md mx-auto z-40">
        {ABAS_NAV.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => onChange(id)}
            className={'flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition ' + (ativa === id ? 'text-primary-dark' : 'text-muted')}>
            <Icon size={19} strokeWidth={ativa === id ? 2.4 : 2} />
            {label}
          </button>
        ))}
      </nav>

      {/* Desktop/tablet: menu lateral fixo */}
      <nav className="hidden md:flex md:flex-col md:w-56 md:shrink-0 md:sticky md:top-0 md:h-screen md:border-r md:border-line md:bg-surface md:py-6 md:px-3">
        <div className="flex items-center gap-2 px-3 mb-8">
          <div className="w-9 h-9 rounded-xl bg-primary text-white flex items-center justify-center shrink-0">
            <Store size={18} />
          </div>
          <div className="leading-tight">
            <p className="font-display font-semibold text-ink text-[15px]">Mercado</p>
            <p className="font-display font-semibold text-primary-dark text-[15px] -mt-1">Inteligente</p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {ABAS_NAV.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => onChange(id)}
              className={'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition text-left ' +
                (ativa === id ? 'bg-primary-light text-primary-dark' : 'text-muted hover:bg-base hover:text-ink')}>
              <Icon size={18} strokeWidth={ativa === id ? 2.4 : 2} />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </>
  )
}

// ============================================================
// APP
// ============================================================

export default function App() {
  const [aba, setAba] = useState('estoque')
  const [editandoCategorias, setEditandoCategorias] = useState(false)

  const secoesHook = useMasterList('secoes')
  const itensHook = useMasterList('itens')
  const marcasHook = useMasterList('marcas')
  const compradoresHook = useMasterList('compradores')
  const listasHook = useMasterList('listas')
  const {
    produtos, loading,
    cadastrarProduto, atualizarCompras, salvarFoto, removerFoto, removerProduto, atualizarCadastro
  } = useProdutos()

  async function handleSalvarEntrada(dados) {
    const secao = secoesHook.lista.find((s) => s.id === dados.secaoId)
    const item = itensHook.lista.find((i) => i.id === dados.itemId)
    const marca = marcasHook.lista.find((m) => m.id === dados.marcaId)
    const marcaIdUsado = dados.marcaId || 'sem-marca'
    const marcaNomeUsado = marca?.nome || 'Sem marca'

    await cadastrarProduto({
      secaoId: dados.secaoId, secaoNome: secao?.nome || '',
      itemId: dados.itemId, itemNome: item?.nome || '',
      marcaId: marcaIdUsado, marcaNome: marcaNomeUsado,
      todasLinhas: dados.todasLinhas
    })
  }

  async function handleExcluirProduto(produtoId) {
    await removerProduto(produtoId)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-base flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={28} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-base md:flex">
      <BottomNav ativa={aba} onChange={setAba} />

      <div className="flex-1 min-w-0">
        <header className="px-4 pt-6 pb-2 md:hidden">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary text-white flex items-center justify-center shrink-0">
              <Store size={16} />
            </div>
            <h1 className="text-xl font-display font-semibold text-ink">Mercado Inteligente</h1>
          </div>
          <p className="text-sm text-muted mt-1">Controle de despensa</p>
        </header>

        <header className="hidden md:block px-8 pt-8 pb-2">
          <h1 className="text-2xl font-display font-semibold text-ink">
            {aba === 'estoque' && 'Produtos cadastrados'}
            {aba === 'compras' && 'Lista de compras'}
          </h1>
        </header>

        <div className="app-shell md:mx-0 md:max-w-none">
          {aba === 'estoque' && (
            <EstoquePanel produtos={produtos} onFoto={salvarFoto} onRemoverFoto={removerFoto}
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista}
              criarSecao={secoesHook.adicionar} criarItem={itensHook.adicionar} criarMarca={marcasHook.adicionar}
              renomearSecao={secoesHook.renomear} renomearItem={itensHook.renomear} renomearMarca={marcasHook.renomear}
              onEditarProduto={atualizarCadastro}
              onExcluirProduto={handleExcluirProduto}
              onSalvarEntrada={handleSalvarEntrada}
              onAbrirEditarCategorias={() => setEditandoCategorias(true)}
              onAtualizarCompras={atualizarCompras}
              compradores={compradoresHook.lista} criarComprador={compradoresHook.adicionar}
              listas={listasHook.lista} criarLista={listasHook.adicionar} />
          )}
          {aba === 'compras' && (
            <ListaComprasPanel produtos={produtos} onAtualizar={atualizarCompras}
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista}
              compradoresHook={compradoresHook} listasHook={listasHook} />
          )}
        </div>
      </div>

      {editandoCategorias && (
        <EditarCategoriasModal
          secoesHook={secoesHook} itensHook={itensHook} marcasHook={marcasHook}
          onFechar={() => setEditandoCategorias(false)} />
      )}
    </div>
  )
}
