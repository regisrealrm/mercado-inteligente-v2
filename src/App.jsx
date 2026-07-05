import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, serverTimestamp, limit as fbLimit
} from 'firebase/firestore'
import { db } from './firebase.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import {
  Plus, Check, X, Pencil, Trash2, Package, ShoppingCart, Settings, Inbox,
  Camera, ClipboardList, ArrowLeftRight, LogOut, Loader2, Printer, Share2, Store, ChevronDown
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

// estoquePorLocal[local] = [{ peso, unidadePeso, unidades }]
function somarVariante(lista, peso, unidadePeso, unidades) {
  const idx = lista.findIndex((v) => v.peso === peso && v.unidadePeso === unidadePeso)
  if (idx >= 0) {
    const copia = [...lista]
    copia[idx] = { ...copia[idx], unidades: copia[idx].unidades + unidades }
    return copia
  }
  return [...lista, { peso, unidadePeso, unidades }]
}

function subtrairVariante(lista, peso, unidadePeso, unidades) {
  return lista
    .map((v) =>
      v.peso === peso && v.unidadePeso === unidadePeso
        ? { ...v, unidades: Math.max(0, v.unidades - unidades) }
        : v
    )
    .filter((v) => v.unidades > 0)
}

function totalUnidadesProduto(produto) {
  return Object.values(produto.estoquePorLocal || {}).reduce(
    (acc, lista) => acc + lista.reduce((s, v) => s + v.unidades, 0),
    0
  )
}

function locaisComEstoque(produto) {
  return Object.entries(produto.estoquePorLocal || {})
    .map(([nome, variantes]) => ({ nome, variantes: (variantes || []).filter((v) => v.unidades > 0) }))
    .filter((l) => l.variantes.length > 0)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }))
}

// Busca o nome atual de uma seção/item/marca pelo id, com fallback pro nome
// que ficou salvo no produto (caso o cadastro original tenha sido apagado).
function nomeAtual(lista, id, nomeFallback) {
  const item = lista.find((x) => x.id === id)
  return item ? item.nome : nomeFallback
}

// Pesos/variações já usados nesse produto em algum local, pra sugerir na lista de compras.
function variantesConhecidas(produto) {
  const mapa = new Map()
  Object.values(produto.estoquePorLocal || {}).forEach((lista) => {
    (lista || []).forEach((v) => {
      const chave = `${v.peso}|${v.unidadePeso}`
      if (!mapa.has(chave)) mapa.set(chave, { peso: v.peso, unidadePeso: v.unidadePeso })
    })
  })
  return [...mapa.values()].sort((a, b) => a.peso - b.peso)
}

function comprasNormalizadas(compras) {
  return {
    desejado: !!compras?.desejado,
    linhas: Array.isArray(compras?.linhas) ? compras.linhas : [],
    compradorId: compras?.compradorId || '',
    compradorNome: compras?.compradorNome || '',
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

  async function registrarEntradaNoProduto({ secaoId, secaoNome, itemId, itemNome, marcaId, marcaNome, linhas, local, controlarEstoque }) {
    const semMovimento = linhas.length === 0
    const existente = encontrar({ secaoId, itemId, marcaId })

    if (existente) {
      let estoquePorLocal = existente.estoquePorLocal || {}
      if (!semMovimento && controlarEstoque) {
        let listaLocal = estoquePorLocal[local] || []
        linhas.forEach((l) => { listaLocal = somarVariante(listaLocal, l.peso, l.unidadePeso, l.unidades) })
        estoquePorLocal = { ...estoquePorLocal, [local]: listaLocal }
      }
      await updateDoc(doc(db, PRODUTOS_COLLECTION, existente.id), {
        controlarEstoque,
        estoquePorLocal,
        atualizadoEm: serverTimestamp()
      })
      return existente.id
    }

    let listaLocal = []
    if (!semMovimento && controlarEstoque) {
      linhas.forEach((l) => { listaLocal = somarVariante(listaLocal, l.peso, l.unidadePeso, l.unidades) })
    }
    const refDoc = await addDoc(collection(db, PRODUTOS_COLLECTION), {
      secaoId, secaoNome, itemId, itemNome, marcaId, marcaNome,
      controlarEstoque,
      estoquePorLocal: listaLocal.length > 0 ? { [local]: listaLocal } : {},
      compras: { desejado: false, linhas: [] },
      foto: null,
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp()
    })
    return refDoc.id
  }

  async function aplicarSaida(produto, { localOrigem, itens }) {
    let listaLocal = produto.estoquePorLocal?.[localOrigem] || []
    itens.forEach((v) => { listaLocal = subtrairVariante(listaLocal, v.peso, v.unidadePeso, v.unidades) })
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produto.id), {
      estoquePorLocal: { ...produto.estoquePorLocal, [localOrigem]: listaLocal },
      atualizadoEm: serverTimestamp()
    })
  }

  async function aplicarTransferencia(produto, { localOrigem, localDestino, itens }) {
    let listaOrigem = produto.estoquePorLocal?.[localOrigem] || []
    let listaDestino = produto.estoquePorLocal?.[localDestino] || []
    itens.forEach((v) => {
      listaOrigem = subtrairVariante(listaOrigem, v.peso, v.unidadePeso, v.unidades)
      listaDestino = somarVariante(listaDestino, v.peso, v.unidadePeso, v.unidades)
    })
    return updateDoc(doc(db, PRODUTOS_COLLECTION, produto.id), {
      estoquePorLocal: { ...produto.estoquePorLocal, [localOrigem]: listaOrigem, [localDestino]: listaDestino },
      atualizadoEm: serverTimestamp()
    })
  }

  // Ajusta o estoque quando uma entrada já registrada é editada:
  // remove a contribuição antiga (local/linhas de antes) e aplica a nova,
  // considerando que "controlar estoque" também pode ter sido ligado/desligado.
  async function ajustarEdicaoEntrada(produto, movAntiga, novosDados) {
    let estoquePorLocal = produto.estoquePorLocal || {}
    const controlavaAntes = produto.controlarEstoque
    const vaiControlarDepois = novosDados.controlarEstoque

    if (controlavaAntes) {
      let listaAntiga = estoquePorLocal[movAntiga.local] || []
      ;(movAntiga.itens || []).forEach((v) => {
        listaAntiga = subtrairVariante(listaAntiga, v.peso, v.unidadePeso, v.unidades)
      })
      estoquePorLocal = { ...estoquePorLocal, [movAntiga.local]: listaAntiga }
    }

    if (vaiControlarDepois) {
      let listaNova = estoquePorLocal[novosDados.local] || []
      novosDados.linhas.forEach((l) => {
        listaNova = somarVariante(listaNova, l.peso, l.unidadePeso, l.unidades)
      })
      estoquePorLocal = { ...estoquePorLocal, [novosDados.local]: listaNova }
    }

    return updateDoc(doc(db, PRODUTOS_COLLECTION, produto.id), {
      controlarEstoque: vaiControlarDepois,
      estoquePorLocal,
      atualizadoEm: serverTimestamp()
    })
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

  return { produtos, loading, registrarEntradaNoProduto, aplicarSaida, aplicarTransferencia, ajustarEdicaoEntrada, atualizarCompras, salvarFoto, removerFoto }
}

const MOVIMENTACOES_COLLECTION = 'movimentacoes'

function useMovimentacoes() {
  const [movimentacoes, setMovimentacoes] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, MOVIMENTACOES_COLLECTION), orderBy('data', 'desc'), fbLimit(500))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setMovimentacoes(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  async function registrar(mov) {
    return addDoc(collection(db, MOVIMENTACOES_COLLECTION), {
      ...mov,
      criadoEm: serverTimestamp()
    })
  }

  async function atualizar(movId, dados) {
    return updateDoc(doc(db, MOVIMENTACOES_COLLECTION, movId), {
      ...dados,
      atualizadoEm: serverTimestamp()
    })
  }

  return { movimentacoes, loading, registrar, atualizar }
}

// ============================================================
// COMPONENTES
// ============================================================

function SelectWithQuickAdd({ label, opcional, valor, onChange, opcoes, onCriar }) {
  const [criando, setCriando] = useState(false)
  const [novoNome, setNovoNome] = useState('')
  const [erro, setErro] = useState('')

  async function confirmar() {
    const nome = novoNome.trim()
    if (!nome) return
    const existe = opcoes.some((o) => o.nome.toLowerCase() === nome.toLowerCase())
    if (existe) {
      setErro(`Já existe um(a) ${label.toLowerCase()} com esse nome`)
      return
    }
    const id = await onCriar(nome)
    if (id) onChange(id)
    setNovoNome('')
    setErro('')
    setCriando(false)
  }

  return (
    <div className="mb-3">
      <label className="text-sm text-muted">{label}{opcional && <span className="text-muted/70"> (opcional)</span>}</label>
      {!criando ? (
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
          <button type="button" onClick={() => setCriando(true)}
            className="w-11 h-11 shrink-0 rounded-xl bg-primary-light text-primary-dark flex items-center justify-center"
            aria-label={`Criar novo ${label}`}>
            <Plus size={20} />
          </button>
        </div>
      ) : (
        <div>
          <div className="flex gap-2 mt-1">
            <input autoFocus
              className={'flex-1 px-3 py-2 rounded-xl border bg-base text-ink ' + (erro ? 'border-danger' : 'border-primary')}
              value={novoNome} onChange={(e) => { setNovoNome(e.target.value); setErro('') }}
              placeholder={`Nome d${label.toLowerCase().startsWith('se') ? 'a' : 'o'} novo ${label.toLowerCase()}`}
              onKeyDown={(e) => e.key === 'Enter' && confirmar()} />
            <button onClick={confirmar} className="w-11 h-11 shrink-0 rounded-xl bg-primary text-white flex items-center justify-center">
              <Check size={18} />
            </button>
            <button onClick={() => { setCriando(false); setNovoNome(''); setErro('') }}
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
const linhaVazia = () => ({ key: novaChaveLinha(), peso: '', unidadePeso: 'kg', unidades: '' })

function EntradaForm({ secoes, itens, marcas, locais, criarSecao, criarItem, criarMarca, criarLocal, onSalvar }) {
  const [secaoId, setSecaoId] = useState('')
  const [itemId, setItemId] = useState('')
  const [marcaId, setMarcaId] = useState('')
  const [linhas, setLinhas] = useState([linhaVazia()])
  const [preco, setPreco] = useState('')
  const [dataEntrada, setDataEntrada] = useState(hojeISO())
  const [localId, setLocalId] = useState('')
  const [controlarEstoque, setControlarEstoque] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [sucesso, setSucesso] = useState(false)

  const valido = secaoId && itemId

  const linhasNormalizadas = linhas.map((l) => ({
    peso: l.peso === '' ? 0 : Number(l.peso),
    unidadePeso: l.unidadePeso,
    unidades: l.unidades === '' ? 0 : Number(l.unidades)
  }))
  const linhasComMovimento = linhasNormalizadas.filter((l) => l.unidades > 0)
  const semMovimento = linhasComMovimento.length === 0

  function atualizarLinha(key, campo, valor) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)))
  }

  async function salvar() {
    if (!valido || salvando) return
    setSalvando(true)
    try {
      const localSel = locais.find((l) => l.id === localId)
      await onSalvar({
        secaoId, itemId, marcaId,
        linhas: linhasComMovimento,
        preco: preco === '' ? null : Number(preco),
        dataEntrada,
        local: localSel?.nome || '',
        controlarEstoque
      })
      setLinhas([linhaVazia()])
      setPreco('')
      setSucesso(true)
      setTimeout(() => setSucesso(false), 1600)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="px-4 pt-4 pb-28">
      <h2 className="text-lg font-display font-semibold text-ink mb-4 md:hidden">Controle de entrada</h2>
      <div className="card p-4">
        <SelectWithQuickAdd label="Seção" valor={secaoId} onChange={setSecaoId} opcoes={secoes} onCriar={criarSecao} />
        <SelectWithQuickAdd label="Item" valor={itemId} onChange={setItemId} opcoes={itens} onCriar={criarItem} />
        <SelectWithQuickAdd label="Marca" opcional valor={marcaId} onChange={setMarcaId} opcoes={marcas} onCriar={criarMarca} />

        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm text-muted">Pesos e quantidades</label>
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
            <input type="number"
              className="w-20 px-3 py-2 rounded-xl border border-line bg-base"
              value={l.unidades} onChange={(e) => atualizarLinha(l.key, 'unidades', e.target.value)} placeholder="Un" />
            {linhas.length > 1 && (
              <button type="button" onClick={() => setLinhas((prev) => prev.filter((x) => x.key !== l.key))}
                className="text-danger p-1 shrink-0">
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
        <p className="text-[11px] text-muted mb-3">
          Ex: 500 ml × 5 un e 1 L × 2 un do mesmo produto — cada peso vira uma variação no estoque.
        </p>

        <div className="mb-3">
          <label className="text-sm text-muted">Preço pago (R$) — opcional</label>
          <input type="number" step="0.01"
            className="w-full mt-1 px-3 py-2 rounded-xl border border-line bg-base"
            value={preco} onChange={(e) => setPreco(e.target.value)} placeholder="0,00" />
        </div>

        <div className="mb-3">
          <label className="text-sm text-muted">Data da entrada</label>
          <input type="date" className="w-full mt-1 px-3 py-2 rounded-xl border border-line bg-base"
            value={dataEntrada} onChange={(e) => setDataEntrada(e.target.value)} />
        </div>

        <SelectWithQuickAdd label="Local" valor={localId} onChange={setLocalId} opcoes={locais} onCriar={criarLocal} />

        <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
          <input type="checkbox" className="w-5 h-5 rounded accent-primary"
            checked={controlarEstoque} onChange={(e) => setControlarEstoque(e.target.checked)} />
          <span className="text-sm text-ink">Controlar estoque deste item</span>
        </label>

        <button disabled={!valido || salvando} onClick={salvar}
          className="btn-primary w-full disabled:opacity-40">
          {salvando ? 'Salvando...' : sucesso ? 'Salvo ✓' : semMovimento ? 'Cadastrar item (sem entrada)' : 'Registrar entrada'}
        </button>

        {semMovimento && (
          <p className="text-xs text-muted mt-2 text-center">
            Sem unidades preenchidas: só cadastra o item no catálogo, sem mexer no estoque nem no histórico. Peso sozinho, sem unidades, não conta como entrada.
          </p>
        )}
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

function MovimentacaoModal({ produto, tipo, locais, criarLocal, onConfirmar, onFechar }) {
  const origens = locaisComEstoque(produto)
  const [localOrigem, setLocalOrigem] = useState(origens[0]?.nome || '')
  const [localDestinoId, setLocalDestinoId] = useState('')
  const [retiradas, setRetiradas] = useState({})
  const [data, setData] = useState(hojeISO())
  const [salvando, setSalvando] = useState(false)

  const ehTransferencia = tipo === 'transferencia'
  const variantesOrigem = origens.find((l) => l.nome === localOrigem)?.variantes || []

  const chaveDe = (v) => `${v.peso}|${v.unidadePeso}`
  const getRetirada = (v) => retiradas[chaveDe(v)] ?? ''

  const itensMovimento = variantesOrigem
    .map((v) => ({
      peso: v.peso,
      unidadePeso: v.unidadePeso,
      unidades: getRetirada(v) === '' ? 0 : Math.min(Number(getRetirada(v)), v.unidades)
    }))
    .filter((v) => v.unidades > 0)

  const destinoSel = locais.find((l) => l.id === localDestinoId)
  const podeConfirmar = itensMovimento.length > 0 && localOrigem &&
    (!ehTransferencia || (destinoSel && destinoSel.nome !== localOrigem))

  async function confirmar() {
    if (!podeConfirmar || salvando) return
    setSalvando(true)
    try {
      await onConfirmar({
        produtoId: produto.id,
        localOrigem,
        localDestino: ehTransferencia ? destinoSel.nome : null,
        itens: itensMovimento,
        data
      })
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-1">{ehTransferencia ? 'Transferir entre locais' : 'Dar saída'}</h2>
        <p className="text-sm text-muted mb-4">{produto.itemNome} — {produto.marcaNome}</p>

        <label className="text-sm text-muted">{ehTransferencia ? 'De' : 'Local'}</label>
        <select className="w-full mt-1 mb-3 px-3 py-2 rounded-xl border border-line bg-base"
          value={localOrigem} onChange={(e) => { setLocalOrigem(e.target.value); setRetiradas({}) }}>
          {origens.map((l) => <option key={l.nome} value={l.nome}>{l.nome}</option>)}
        </select>

        {ehTransferencia && (
          <SelectWithQuickAdd label="Para" valor={localDestinoId} onChange={setLocalDestinoId}
            opcoes={locais.filter((l) => l.nome !== localOrigem)} onCriar={criarLocal} />
        )}

        <label className="text-sm text-muted block mb-1">
          {ehTransferencia ? 'Quanto mover de cada peso' : 'Quanto retirar de cada peso'}
        </label>
        <div className="flex flex-col gap-2 mb-4">
          {variantesOrigem.length === 0 && <p className="text-sm text-muted">Nenhum estoque neste local.</p>}
          {variantesOrigem.map((v) => (
            <div key={chaveDe(v)} className="flex items-center gap-3 bg-base rounded-xl border border-line px-3 py-2">
              <div className="flex-1">
                <span className="font-medium text-ink">{rotuloVariante(v)}</span>
                <span className="ml-2 text-sm font-semibold text-primary-dark">tem {v.unidades} un</span>
              </div>
              <input type="number" min="0" max={v.unidades}
                className="w-20 px-3 py-1.5 rounded-lg border border-line bg-surface text-center"
                value={getRetirada(v)}
                onChange={(e) => setRetiradas((prev) => ({ ...prev, [chaveDe(v)]: e.target.value }))}
                placeholder="0" />
            </div>
          ))}
        </div>

        <label className="text-sm text-muted">Data</label>
        <input type="date" className="w-full mt-1 mb-4 px-3 py-2 rounded-xl border border-line bg-base"
          value={data} onChange={(e) => setData(e.target.value)} />

        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onFechar}>Cancelar</button>
          <button disabled={!podeConfirmar || salvando} onClick={confirmar}
            className={'flex-1 rounded-xl px-4 py-2.5 font-medium text-white disabled:opacity-40 ' + (ehTransferencia ? 'bg-warn' : 'bg-danger')}>
            {salvando ? 'Salvando...' : ehTransferencia ? 'Confirmar transferência' : 'Confirmar saída'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EstoquePanel({ produtos: produtosBrutos, onFoto, onRemoverFoto, onSaida, onTransferencia, locais, criarLocal, secoes, itens, marcas, movimentacoes, onEditarEntrada }) {
  const produtos = useMemo(() => produtosBrutos.map((p) => ({
    ...p,
    itemNome: nomeAtual(itens, p.itemId, p.itemNome),
    marcaNome: nomeAtual(marcas, p.marcaId, p.marcaNome),
    secaoNome: nomeAtual(secoes, p.secaoId, p.secaoNome)
  })), [produtosBrutos, itens, marcas, secoes])

  const controlados = produtos.filter((p) => p.controlarEstoque)
  const [carregandoId, setCarregandoId] = useState(null)
  const [fotoAmpliadaId, setFotoAmpliadaId] = useState(null)
  const [modal, setModal] = useState(null)
  const [editandoEntrada, setEditandoEntrada] = useState(null)

  const produtoAmpliado = produtos.find((p) => p.id === fotoAmpliadaId) || null

  function ultimaEntrada(produtoId) {
    return movimentacoes
      .filter((m) => m.tipo === 'entrada' && m.produtoId === produtoId)
      .sort((a, b) => (b.data || '').localeCompare(a.data || ''))[0] || null
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
      <h2 className="text-lg font-display font-semibold text-ink mb-4 md:hidden">Estoque controlado</h2>
      {controlados.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-ink font-medium mb-1">Nada em controle de estoque ainda</p>
          <p className="text-sm text-muted">Marque "Controlar estoque" ao registrar uma entrada pra ele aparecer aqui.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3 md:items-start">
        {controlados.map((p) => {
          const totalUn = totalUnidadesProduto(p)
          const porLocal = locaisComEstoque(p)
          const temEstoque = totalUn > 0
          const entradaRecente = ultimaEntrada(p.id)
          return (
            <div key={p.id} className="card card-accent p-2.5" style={{ '--accent-stripe': temEstoque ? '#2F8145' : '#D6472A' }}>
              <div className="flex items-center gap-2.5">
                <FotoThumb produto={p} onEscolherArquivo={handleEscolherArquivo} onAmpliar={(produto) => setFotoAmpliadaId(produto.id)} carregando={carregandoId === p.id} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className="font-medium text-ink text-[13.5px] truncate">{p.itemNome}</span>
                    <span className="text-muted text-xs truncate">— {p.marcaNome}</span>
                  </div>
                  <span className="tag-feira text-primary-dark mt-1">{p.secaoNome}</span>
                </div>
                <div className="text-right shrink-0 pl-1">
                  <div className="font-mono font-bold text-primary-dark leading-none text-[15px]">{totalUn}</div>
                  <div className="text-[9px] text-muted uppercase tracking-wide">un total</div>
                </div>
              </div>

              {porLocal.length > 0 && (
                <div className="flex flex-col gap-0.5 mt-2 pl-[46px]">
                  {porLocal.map((l) => (
                    <div key={l.nome} className="text-[10.5px] text-muted truncate">
                      <span className="font-medium text-ink">{l.nome}:</span>{' '}
                      {l.variantes.map((v) => `${rotuloVariante(v)} ×${v.unidades}`).join('  ·  ')}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-1.5 mt-2 pl-[46px]">
                <button disabled={!temEstoque} onClick={() => setModal({ tipo: 'saida', produto: p })}
                  className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-danger-light text-danger disabled:opacity-40">
                  <LogOut size={12} /> Saída
                </button>
                <button disabled={!temEstoque} onClick={() => setModal({ tipo: 'transferencia', produto: p })}
                  className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-warn-light text-warn disabled:opacity-40">
                  <ArrowLeftRight size={12} /> Transferir
                </button>
                <button disabled={!entradaRecente} onClick={() => setEditandoEntrada({ movimentacao: entradaRecente, produto: p })}
                  title="Editar última entrada" aria-label="Editar última entrada"
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-base border border-line text-muted disabled:opacity-30">
                  <Pencil size={12} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <FotoAmpliadaModal produto={produtoAmpliado} onFechar={() => setFotoAmpliadaId(null)}
        onTrocarFoto={handleEscolherArquivo} onRemoverFoto={handleRemoverFoto}
        carregando={carregandoId === fotoAmpliadaId} />

      {modal && (
        <MovimentacaoModal produto={modal.produto} tipo={modal.tipo} locais={locais} criarLocal={criarLocal}
          onFechar={() => setModal(null)}
          onConfirmar={async (dados) => {
            if (modal.tipo === 'saida') await onSaida(dados)
            else await onTransferencia(dados)
            setModal(null)
          }} />
      )}

      {editandoEntrada && (
        <EditarEntradaModal
          movimentacao={editandoEntrada.movimentacao}
          produto={editandoEntrada.produto}
          locais={locais}
          criarLocal={criarLocal}
          onFechar={() => setEditandoEntrada(null)}
          onConfirmar={async (dados) => {
            await onEditarEntrada(editandoEntrada.movimentacao, dados)
            setEditandoEntrada(null)
          }} />
      )}
    </div>
  )
}

let chaveCompra = 1
const novaChaveCompra = () => String(chaveCompra++)

function LinhaProduto({ produto, onAtualizar, onAmpliarFoto, compradores, criarComprador }) {
  const compras = comprasNormalizadas(produto.compras)
  const [linhas, setLinhas] = useState(() =>
    compras.linhas.length > 0
      ? compras.linhas.map((l) => ({ key: novaChaveCompra(), peso: l.peso || '', unidadePeso: l.unidadePeso || 'kg', unidades: l.unidades || '' }))
      : [{ key: novaChaveCompra(), peso: '', unidadePeso: 'kg', unidades: '' }]
  )
  const [compradorId, setCompradorId] = useState(() => compradores.find((c) => c.nome === compras.compradorNome)?.id || '')
  const [aberto, setAberto] = useState(false)
  const variantes = variantesConhecidas(produto)

  function salvar(patch) {
    const linhasFonte = patch.linhas || linhas
    onAtualizar(produto.id, {
      desejado: patch.desejado ?? compras.desejado,
      compradorId: patch.compradorId ?? compras.compradorId,
      compradorNome: patch.compradorNome ?? compras.compradorNome,
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
    salvar({ desejado: novoDesejado })
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

  const resumoQuantidade = linhasQuantidadeFormatadas(compras.linhas).join(' · ')

  return (
    <div className={'card p-2.5 ' + (compras.comprado ? 'opacity-55' : compras.desejado ? 'ring-1 ring-primary border-primary' : '')}>
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
            <span className={'font-medium text-ink text-[13.5px] truncate ' + (compras.comprado ? 'line-through' : '')}>{produto.itemNome}</span>
            <span className="text-muted text-xs truncate">— {produto.marcaNome}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            <span className="tag-feira text-accent-dark">{produto.secaoNome}</span>
            {compras.compradorNome && <span className="text-[10px] text-muted">👤 {compras.compradorNome}</span>}
          </div>
        </div>
      </div>

      {compras.desejado && !aberto && (
        <div className="mt-2 pl-[42px] flex items-center justify-between gap-2">
          <span className="text-xs text-muted truncate">{resumoQuantidade || 'Sem quantidade definida'}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => salvar({ comprado: !compras.comprado })}
              className={'flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg ' + (compras.comprado ? 'bg-primary text-white' : 'bg-base border border-line text-ink')}>
              <Check size={11} /> {compras.comprado ? 'Comprado' : 'Comprei'}
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

          <SelectWithQuickAdd label="Comprador" opcional valor={compradorId} onChange={escolherComprador} opcoes={compradores} onCriar={criarComprador} />

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => salvar({ comprado: !compras.comprado })}
              className={'flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg ' + (compras.comprado ? 'bg-primary text-white' : 'bg-base border border-line text-ink')}>
              <Check size={13} /> {compras.comprado ? 'Comprado ✓' : 'Comprei'}
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

function ListaComprasPanel({ produtos: produtosBrutos, onAtualizar, secoes, itens, marcas, compradores, criarComprador }) {
  const [filtro, setFiltro] = useState('todos')
  const [filtroSecao, setFiltroSecao] = useState('todas')
  const [filtroComprador, setFiltroComprador] = useState('todos')
  const [fotoAmpliadaId, setFotoAmpliadaId] = useState(null)

  // Sempre resolve o nome atual da seção/item/marca pelo id, em vez do texto
  // que ficou salvo na hora da entrada — assim renomear em Ajustes reflete aqui.
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

  const visiveis = produtos
    .filter((p) => (filtro === 'selecionados' ? comprasNormalizadas(p.compras).desejado : true))
    .filter((p) => (filtroSecao === 'todas' ? true : p.secaoNome === filtroSecao))
    .filter((p) => {
      if (filtroComprador === 'todos') return true
      const nomeComprador = comprasNormalizadas(p.compras).compradorNome
      if (filtroComprador === 'sem') return !nomeComprador
      return nomeComprador === filtroComprador
    })

  const selecionados = produtos
    .map((p) => ({ produto: p, compras: comprasNormalizadas(p.compras) }))
    .filter((x) => x.compras.desejado)
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

  return (
    <div className="px-4 pt-4 pb-28">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-display font-semibold text-ink md:hidden">Lista de compras</h2>
        {totalSel > 0 && (
          <span className="text-xs bg-primary-light text-primary-dark px-2 py-1 rounded-full font-medium">
            {totalSel} selecionado{totalSel > 1 ? 's' : ''}
          </span>
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
        {compradores.length > 0 && (
          <select value={filtroComprador} onChange={(e) => setFiltroComprador(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-line bg-surface text-sm text-ink">
            <option value="todos">Todos os compradores</option>
            <option value="sem">Sem comprador</option>
            {compradores.map((c) => (
              <option key={c.id} value={c.nome}>{c.nome}</option>
            ))}
          </select>
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
            "Imprimir" abre o relatório pronto pra impressora. No celular, "Enviar no WhatsApp" já anexa o PDF direto; se o aparelho não suportar, ele baixa o PDF e abre o WhatsApp pra anexar na conversa.
          </p>
        </div>
      )}

      {visiveis.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-ink font-medium mb-1">
            {filtroSecao !== 'todas' || filtroComprador !== 'todos' ? 'Nada com esse filtro' : filtro === 'selecionados' ? 'Nada selecionado ainda' : 'Nenhum produto cadastrado ainda'}
          </p>
          <p className="text-sm text-muted">
            {filtroSecao !== 'todas' || filtroComprador !== 'todos' ? 'Tenta ajustar os filtros pra ver os outros produtos.' : filtro === 'selecionados' ? 'Marque a caixinha de um produto pra colocar na lista.' : 'Produtos aparecem aqui automaticamente após a primeira entrada.'}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3 md:items-start">
        {visiveis.map((p) => (
          <LinhaProduto key={p.id} produto={p} onAtualizar={onAtualizar}
            onAmpliarFoto={() => setFotoAmpliadaId(p.id)}
            compradores={compradores} criarComprador={criarComprador} />
        ))}
      </div>

      <FotoAmpliadaModal produto={produtoAmpliado} onFechar={() => setFotoAmpliadaId(null)} />
    </div>
  )
}

function descreverItensMovimento(m) {
  if (Array.isArray(m.itens) && m.itens.length > 0) {
    return m.itens.map((v) => `${rotuloVariante(v)} ×${v.unidades}`).join('  ·  ')
  }
  return ''
}

function EditarEntradaModal({ movimentacao, produto, locais, criarLocal, onConfirmar, onFechar }) {
  const [linhas, setLinhas] = useState(() =>
    movimentacao.itens && movimentacao.itens.length > 0
      ? movimentacao.itens.map((l) => ({ key: novaChaveLinha(), peso: l.peso || '', unidadePeso: l.unidadePeso || 'kg', unidades: l.unidades || '' }))
      : [linhaVazia()]
  )
  const [preco, setPreco] = useState(movimentacao.preco != null ? String(movimentacao.preco) : '')
  const [data, setData] = useState(movimentacao.data || hojeISO())
  const [localId, setLocalId] = useState(() => locais.find((l) => l.nome === movimentacao.local)?.id || '')
  const [controlarEstoque, setControlarEstoque] = useState(produto?.controlarEstoque ?? true)
  const [salvando, setSalvando] = useState(false)

  function atualizarLinha(key, campo, valor) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)))
  }

  async function confirmar() {
    const localSel = locais.find((l) => l.id === localId)
    if (!localSel || salvando) return
    setSalvando(true)
    try {
      const linhasNormalizadas = linhas
        .map((l) => ({
          peso: l.peso === '' ? 0 : Number(l.peso),
          unidadePeso: l.unidadePeso,
          unidades: l.unidades === '' ? 0 : Number(l.unidades)
        }))
        .filter((l) => l.unidades > 0)
      await onConfirmar({
        linhas: linhasNormalizadas,
        local: localSel.nome,
        data,
        preco: preco === '' ? null : Number(preco),
        controlarEstoque
      })
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end justify-center z-50" onClick={onFechar}>
      <div className="bg-surface w-full max-w-md rounded-t-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 bg-line rounded-full mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-1">Editar entrada</h2>
        <p className="text-sm text-muted mb-4">{produto ? `${produto.itemNome} — ${produto.marcaNome}` : 'Item removido'}</p>

        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm text-muted">Pesos e quantidades</label>
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
            <input type="number"
              className="w-20 px-3 py-2 rounded-xl border border-line bg-base"
              value={l.unidades} onChange={(e) => atualizarLinha(l.key, 'unidades', e.target.value)} placeholder="Un" />
            {linhas.length > 1 && (
              <button type="button" onClick={() => setLinhas((prev) => prev.filter((x) => x.key !== l.key))}
                className="text-danger p-1 shrink-0">
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}

        <div className="mb-3 mt-2">
          <label className="text-sm text-muted">Preço pago (R$) — opcional</label>
          <input type="number" step="0.01"
            className="w-full mt-1 px-3 py-2 rounded-xl border border-line bg-base"
            value={preco} onChange={(e) => setPreco(e.target.value)} placeholder="0,00" />
        </div>

        <div className="mb-3">
          <label className="text-sm text-muted">Data da entrada</label>
          <input type="date" className="w-full mt-1 px-3 py-2 rounded-xl border border-line bg-base"
            value={data} onChange={(e) => setData(e.target.value)} />
        </div>

        <SelectWithQuickAdd label="Local" valor={localId} onChange={setLocalId} opcoes={locais} onCriar={criarLocal} />

        <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
          <input type="checkbox" className="w-5 h-5 rounded accent-primary"
            checked={controlarEstoque} onChange={(e) => setControlarEstoque(e.target.checked)} />
          <span className="text-sm text-ink">Controlar estoque deste item</span>
        </label>

        <p className="text-[11px] text-muted mb-3">
          O estoque é ajustado automaticamente: o que essa entrada tinha somado é removido e o novo valor é aplicado no lugar. Desmarcar aqui também para de contar o estoque deste produto a partir de agora.
        </p>

        <div className="flex gap-2 mt-2">
          <button className="btn-secondary flex-1" onClick={onFechar}>Cancelar</button>
          <button disabled={salvando || !localId} onClick={confirmar} className="btn-primary flex-1 disabled:opacity-40">
            {salvando ? 'Salvando...' : 'Salvar alterações'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RelatoriosPanel({ movimentacoes, produtos, secoes, itens, marcas }) {
  const [filtro, setFiltro] = useState('todos')

  const produtoPorId = useMemo(() => {
    const mapa = {}
    produtos.forEach((p) => {
      mapa[p.id] = {
        ...p,
        itemNome: nomeAtual(itens, p.itemId, p.itemNome),
        marcaNome: nomeAtual(marcas, p.marcaId, p.marcaNome),
        secaoNome: nomeAtual(secoes, p.secaoId, p.secaoNome)
      }
    })
    return mapa
  }, [produtos, itens, marcas, secoes])

  const visiveis = useMemo(() => {
    const lista = filtro === 'todos' ? movimentacoes : movimentacoes.filter((m) => m.tipo === filtro)
    return [...lista].sort((a, b) => (b.data || '').localeCompare(a.data || ''))
  }, [movimentacoes, filtro])

  const estilos = {
    entrada: { label: 'Entrada', cor: 'bg-primary-light text-primary-dark', stripe: '#2F8145' },
    saida: { label: 'Saída', cor: 'bg-danger-light text-danger', stripe: '#D6472A' },
    transferencia: { label: 'Transferência', cor: 'bg-warn-light text-warn', stripe: '#E0961F' }
  }

  return (
    <div className="px-4 pt-4 pb-28">
      <h2 className="text-lg font-display font-semibold text-ink mb-4 md:hidden">Relatórios</h2>

      <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar">
        {[
          { id: 'todos', label: 'Todos' },
          { id: 'entrada', label: 'Entradas' },
          { id: 'saida', label: 'Saídas' },
          { id: 'transferencia', label: 'Transferências' }
        ].map((f) => (
          <button key={f.id} onClick={() => setFiltro(f.id)}
            className={'chip whitespace-nowrap ' + (filtro === f.id ? 'bg-primary text-white border-primary' : 'bg-surface text-muted border-line')}>
            {f.label}
          </button>
        ))}
      </div>

      {visiveis.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-ink font-medium mb-1">Nada por aqui ainda</p>
          <p className="text-sm text-muted">O histórico de entradas, saídas e transferências aparece aqui.</p>
        </div>
      )}

      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3 md:items-start">
        {visiveis.map((m) => {
          const produto = produtoPorId[m.produtoId]
          const estilo = estilos[m.tipo]
          if (!estilo) return null
          return (
            <div key={m.id} className="card card-accent p-3" style={{ '--accent-stripe': estilo.stripe }}>
              <div className="flex items-center justify-between mb-1">
                <span className={'text-[11px] font-semibold px-2 py-0.5 rounded-full ' + estilo.cor}>{estilo.label}</span>
                <span className="text-xs text-muted">{formatarData(m.data)}</span>
              </div>
              <div className="font-medium text-ink">
                {produto ? `${produto.itemNome} — ${produto.marcaNome}` : 'Item removido'}
              </div>
              <div className="text-sm text-muted mt-0.5">{descreverItensMovimento(m)}</div>
              <div className="text-xs text-muted mt-1">
                {m.tipo === 'transferencia' ? `${m.localOrigem} → ${m.localDestino}` : (m.local || m.localOrigem || '—')}
                {m.tipo === 'entrada' && m.preco != null && ` · R$ ${Number(m.preco).toFixed(2)}`}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GerenciadorLista({ titulo, placeholder, lista, adicionar, renomear, remover }) {
  const [aberto, setAberto] = useState(false)
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
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-ink">{titulo} <span className="text-muted font-normal text-sm">({lista.length})</span></h3>
        <button onClick={() => setAberto((v) => !v)} className="text-muted p-1" aria-label={aberto ? 'Recolher lista' : 'Expandir lista'}>
          <ChevronDown size={18} className={'transition-transform ' + (aberto ? 'rotate-180' : '')} />
        </button>
      </div>
      <div className="flex gap-2">
        <input className="flex-1 px-3 py-2 rounded-xl border bg-base"
          style={{ borderColor: erro ? '#D6472A' : undefined }}
          value={novoNome} onChange={(e) => { setNovoNome(e.target.value); setErro('') }}
          placeholder={placeholder}
          onKeyDown={(e) => e.key === 'Enter' && handleAdicionar()} />
        <button onClick={handleAdicionar} className="btn-primary px-4">Add</button>
      </div>
      {erro && <p className="text-xs text-danger mt-1.5">{erro}</p>}

      {aberto && (
        <div className="flex flex-col gap-1.5 mt-3">
          {lista.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1.5 border-b border-line last:border-0">
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
                  <button onClick={() => iniciarEdicao(item)} className="text-muted p-1.5"><Pencil size={15} /></button>
                  <button onClick={() => remover(item.id)} className="text-danger p-1.5"><Trash2 size={15} /></button>
                </>
              )}
            </div>
          ))}
          {lista.length === 0 && <p className="text-sm text-muted py-2">Nenhuma ainda.</p>}
        </div>
      )}
    </div>
  )
}

function AjustesPanel({ secoesHook, itensHook, marcasHook, locaisHook, compradoresHook }) {
  return (
    <div className="px-4 pt-4 pb-28">
      <h2 className="text-lg font-display font-semibold text-ink mb-4 md:hidden">Ajustes</h2>
      <p className="text-sm text-muted mb-4">Gerencie aqui as opções que aparecem no Controle de entrada.</p>
      <GerenciadorLista titulo="Seção" placeholder="nome da seção" lista={secoesHook.lista} adicionar={secoesHook.adicionar} renomear={secoesHook.renomear} remover={secoesHook.remover} />
      <GerenciadorLista titulo="Item" placeholder="nome do item" lista={itensHook.lista} adicionar={itensHook.adicionar} renomear={itensHook.renomear} remover={itensHook.remover} />
      <GerenciadorLista titulo="Marca" placeholder="nome da marca" lista={marcasHook.lista} adicionar={marcasHook.adicionar} renomear={marcasHook.renomear} remover={marcasHook.remover} />
      <GerenciadorLista titulo="Local" placeholder="nome do local" lista={locaisHook.lista} adicionar={locaisHook.adicionar} renomear={locaisHook.renomear} remover={locaisHook.remover} />
      <GerenciadorLista titulo="Comprador" placeholder="nome do comprador" lista={compradoresHook.lista} adicionar={compradoresHook.adicionar} renomear={compradoresHook.renomear} remover={compradoresHook.remover} />
      <p className="text-xs text-muted -mt-2">
        Renomear ou excluir um local aqui não altera o estoque já registrado nele.
      </p>
    </div>
  )
}

const ABAS_NAV = [
  { id: 'entrada', label: 'Entrada', Icon: Inbox },
  { id: 'estoque', label: 'Estoque', Icon: Package },
  { id: 'compras', label: 'Compras', Icon: ShoppingCart },
  { id: 'relatorios', label: 'Relatórios', Icon: ClipboardList },
  { id: 'ajustes', label: 'Ajustes', Icon: Settings }
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
  const [aba, setAba] = useState('entrada')

  const secoesHook = useMasterList('secoes')
  const itensHook = useMasterList('itens')
  const marcasHook = useMasterList('marcas')
  const locaisHook = useMasterList('locais')
  const compradoresHook = useMasterList('compradores')
  const {
    produtos, loading,
    registrarEntradaNoProduto, aplicarSaida, aplicarTransferencia, ajustarEdicaoEntrada,
    atualizarCompras, salvarFoto, removerFoto
  } = useProdutos()
  const { movimentacoes, registrar, atualizar: atualizarMovimentacao } = useMovimentacoes()

  async function handleSalvarEntrada(dados) {
    const secao = secoesHook.lista.find((s) => s.id === dados.secaoId)
    const item = itensHook.lista.find((i) => i.id === dados.itemId)
    const marca = marcasHook.lista.find((m) => m.id === dados.marcaId)
    const localUsado = dados.local || 'Sem local'
    const marcaIdUsado = dados.marcaId || 'sem-marca'
    const marcaNomeUsado = marca?.nome || 'Sem marca'

    const produtoId = await registrarEntradaNoProduto({
      secaoId: dados.secaoId, secaoNome: secao?.nome || '',
      itemId: dados.itemId, itemNome: item?.nome || '',
      marcaId: marcaIdUsado, marcaNome: marcaNomeUsado,
      linhas: dados.linhas,
      local: localUsado,
      controlarEstoque: dados.controlarEstoque
    })

    if (dados.linhas.length > 0) {
      await registrar({
        tipo: 'entrada',
        produtoId,
        itens: dados.linhas,
        local: localUsado,
        data: dados.dataEntrada,
        preco: dados.preco
      })
    }
  }

  async function handleEditarEntrada(movAntiga, dadosNovos) {
    const produto = produtos.find((p) => p.id === movAntiga.produtoId)
    if (!produto) return
    await ajustarEdicaoEntrada(produto, movAntiga, dadosNovos)
    await atualizarMovimentacao(movAntiga.id, {
      itens: dadosNovos.linhas,
      local: dadosNovos.local,
      data: dadosNovos.data,
      preco: dadosNovos.preco
    })
  }


  async function handleSaida(dados) {
    const produto = produtos.find((p) => p.id === dados.produtoId)
    if (!produto) return
    await aplicarSaida(produto, dados)
    await registrar({
      tipo: 'saida',
      produtoId: dados.produtoId,
      local: dados.localOrigem,
      itens: dados.itens,
      data: dados.data
    })
  }

  async function handleTransferencia(dados) {
    const produto = produtos.find((p) => p.id === dados.produtoId)
    if (!produto) return
    await aplicarTransferencia(produto, dados)
    await registrar({
      tipo: 'transferencia',
      produtoId: dados.produtoId,
      localOrigem: dados.localOrigem,
      localDestino: dados.localDestino,
      itens: dados.itens,
      data: dados.data
    })
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
            {aba === 'entrada' && 'Controle de entrada'}
            {aba === 'estoque' && 'Estoque controlado'}
            {aba === 'compras' && 'Lista de compras'}
            {aba === 'relatorios' && 'Relatórios'}
            {aba === 'ajustes' && 'Ajustes'}
          </h1>
        </header>

        <div className="app-shell md:mx-0 md:max-w-none">
          {aba === 'entrada' && (
            <EntradaForm
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista} locais={locaisHook.lista}
              criarSecao={secoesHook.adicionar} criarItem={itensHook.adicionar}
              criarMarca={marcasHook.adicionar} criarLocal={locaisHook.adicionar}
              onSalvar={handleSalvarEntrada} />
          )}
          {aba === 'estoque' && (
            <EstoquePanel produtos={produtos} onFoto={salvarFoto} onRemoverFoto={removerFoto}
              onSaida={handleSaida} onTransferencia={handleTransferencia}
              locais={locaisHook.lista} criarLocal={locaisHook.adicionar}
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista}
              movimentacoes={movimentacoes} onEditarEntrada={handleEditarEntrada} />
          )}
          {aba === 'compras' && (
            <ListaComprasPanel produtos={produtos} onAtualizar={atualizarCompras}
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista}
              compradores={compradoresHook.lista} criarComprador={compradoresHook.adicionar} />
          )}
          {aba === 'relatorios' && (
            <RelatoriosPanel movimentacoes={movimentacoes} produtos={produtos}
              secoes={secoesHook.lista} itens={itensHook.lista} marcas={marcasHook.lista} />
          )}
          {aba === 'ajustes' && (
            <AjustesPanel secoesHook={secoesHook} itensHook={itensHook} marcasHook={marcasHook} locaisHook={locaisHook} compradoresHook={compradoresHook} />
          )}
        </div>
      </div>
    </div>
  )
}
